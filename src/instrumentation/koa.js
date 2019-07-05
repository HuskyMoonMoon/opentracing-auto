'use strict'

const debug = require('debug')('opentracing-auto:instrumentation:koa')
const { Tags, FORMAT_HTTP_HEADERS } = require('opentracing')
const shimmer = require('shimmer')
const cls = require('../cls')

const METHODS = ['use', 'handleRequest']
const OPERATION_NAME = 'http_server'
const TAG_REQUEST_PATH = 'request_path'

function patch (koa, tracers) {
  debug('Koa patched')
  function applicationActionWrap (method) {
    return function applicationActionWrapped (...args) {
      if (!this._jaeger_trace_patched && !this._router) {
        this._jaeger_trace_patched = true
        this.use(middleware)
      }
      return method.call(this, ...args)
    }
  }

  function middleware (ctx, next) {
    return cls.runAndReturn(() => {
      // start
      const url = `${ctx.request.protocol}://${ctx.request.get('host')}${ctx.request.originalUrl}`
      const parentSpanContexts = tracers.map((tracer) => tracer.extract(FORMAT_HTTP_HEADERS, ctx.request.headers))
      const spans = parentSpanContexts.map((parentSpanContext, key) =>
        cls.startRootSpan(tracers[key], `${ctx.request.method} ${url}`, {
          childOf: parentSpanContext,
          tags: {
            [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
            [Tags.HTTP_URL]: url,
            [Tags.HTTP_METHOD]: ctx.request.method
          }
        }))
      debug(`Operation started ${OPERATION_NAME}`, {
        [Tags.HTTP_URL]: url,
        [Tags.HTTP_METHOD]: ctx.request.method
      })
      if (ctx.req.remoteAddress) {
        spans.forEach((span) => span.log({ peerRemoteAddress: ctx.request.remoteAddress }))
      }

      // end
      const originalEnd = ctx.res.end

      ctx.res.end = function (...args) {
        const returned = originalEnd.call(this, ...args)

        if (ctx.req.route && ctx.req.route.path) {
          spans.forEach((span) => span.setTag(TAG_REQUEST_PATH, ctx.req.route.path))
        }

        spans.forEach((span) => span.setTag(Tags.HTTP_STATUS_CODE, ctx.response.status))

        if (ctx.response.status > 399) {
          spans.forEach((span) => {
            span.setTag(Tags.ERROR, true)
          })

          debug(`Operation error captured ${OPERATION_NAME}`, {
            reason: 'Bad status code',
            statusCode: ctx.response.status
          })
        }

        spans.forEach((span) => span.finish())

        debug(`Operation finished ${OPERATION_NAME}`, {
          [Tags.HTTP_STATUS_CODE]: ctx.response.status
        })

        ctx.res.end = originalEnd

        return returned
      }

      return next()
    })
  }
  METHODS.forEach((method) => {
    shimmer.wrap(koa.prototype, method, applicationActionWrap)
    debug(`Method patched ${method}`)
  })

  debug('Patched')
}

function unpatch (koa) {
  METHODS.forEach((method) => {
    shimmer.unwrap(koa.prototype, method)
    debug(`Method unpatched ${method}`)
  })

  debug('Unpatched')
}

module.exports = {
  name: 'koa',
  module: 'koa',
  supportedVersions: ['2.x'],
  TAG_REQUEST_PATH,
  OPERATION_NAME,
  patch,
  unpatch
}
