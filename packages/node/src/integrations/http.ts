import { getCurrentHub } from '@sentry/core';
import { Integration, Span, Transaction } from '@sentry/types';
import { fill, parseSemver, stripUrlQueryAndFragment } from '@sentry/utils';
import * as http from 'http';
import * as https from 'https';

const NODE_VERSION = parseSemver(process.versions.node);

/** http module integration */
export class Http implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'Http';

  /**
   * @inheritDoc
   */
  public name: string = Http.id;

  /**
   * Whether or not to record outgoing requests as breadcrumbs
   */
  private readonly _breadcrumbs: boolean;

  /**
   * Whether or not to record outgoing requests as tracing spans
   */
  private readonly _tracing: boolean;

  /**
   * Hook allowing filering of request spans
   */
  private readonly _shouldCreateSpan?: (url: string) => boolean;

  /**
   * @inheritDoc
   */
  public constructor(
    options: { breadcrumbs?: boolean; tracing?: boolean; shouldCreateSpanForRequest?: (url: string) => boolean } = {},
  ) {
    this._breadcrumbs = typeof options.breadcrumbs === 'undefined' ? true : options.breadcrumbs;
    this._tracing = typeof options.tracing === 'undefined' ? false : options.tracing;
    this._shouldCreateSpan = options.shouldCreateSpanForRequest;
  }

  /**
   * @inheritDoc
   */
  public setupOnce(): void {
    // No need to instrument if we don't want to track anything
    if (!this._breadcrumbs && !this._tracing) {
      return;
    }

    const wrappedHandlerMaker = _createWrappedHandlerMaker(this._breadcrumbs, this._tracing, this._shouldCreateSpan);

    const httpModule = require('http');
    fill(httpModule, 'get', wrappedHandlerMaker);
    fill(httpModule, 'request', wrappedHandlerMaker);

    // NOTE: Prior to Node 9, `https` used internals of `http` module, thus we don't patch it.
    // If we do, we'd get double breadcrumbs and double spans for `https` calls.
    // It has been changed in Node 9, so for all versions equal and above, we patch `https` separately.
    if (NODE_VERSION.major && NODE_VERSION.major > 8) {
      const httpsModule = require('https');
      fill(httpsModule, 'get', wrappedHandlerMaker);
      fill(httpsModule, 'request', wrappedHandlerMaker);
    }
  }
}

type OriginalHandler = () => http.ClientRequest;
type WrappedHandler = (options: string | http.ClientRequestArgs) => http.ClientRequest;
type WrappedHandlerMaker = (originalHandler: OriginalHandler) => WrappedHandler;

/**
 * Function which creates a function which creates wrapped versions of internal `request` and `get` calls within `http`
 * and `https` modules. (NB: Not a typo - this is a creator^2!)
 *
 * @param breadcrumbsEnabled Whether or not to record outgoing requests as breadcrumbs
 * @param tracingEnabled Whether or not to record outgoing requests as tracing spans
 * @param shouldCreateSpan Optional hook for controling which rquests get recorded as spans
 *
 * @returns A function which accepts the exiting handler and returns a wrapped handler
 */
function _createWrappedHandlerMaker(
  breadcrumbsEnabled: boolean,
  tracingEnabled: boolean,
  shouldCreateSpan?: (url: string) => boolean,
): WrappedHandlerMaker {
  return function wrappedHandlerMaker(originalHandler: OriginalHandler): WrappedHandler {
    return function wrappedHandler(
      this: typeof http | typeof https,
      options: string | http.ClientRequestArgs,
    ): http.ClientRequest {
      const requestUrl = extractUrl(options);

      // we don't want to record requests to Sentry as either breadcrumbs or spans, so just use the original handler
      if (isSentryRequest(requestUrl)) {
        return originalHandler.apply(this, arguments);
      }

      // apply user-provided filter (if any) and cache result for next time
      const spanDecisionCache: { [key: string]: boolean } = {};
      const shouldStartSpan = (url: string): boolean => {
        const cached = spanDecisionCache[url];
        if (cached) {
          return cached;
        }

        const spanDecision = typeof shouldCreateSpan === 'function' ? shouldCreateSpan(url) : true;
        spanDecisionCache[url] = spanDecision;

        return spanDecision;
      };

      let span: Span | undefined;
      let transaction: Transaction | undefined;

      const scope = getCurrentHub().getScope();
      if (scope && tracingEnabled) {
        transaction = scope.getTransaction();
        if (transaction && shouldStartSpan(requestUrl)) {
          span = transaction.startChild({
            description: `${typeof options === 'string' || !options.method ? 'GET' : options.method} ${requestUrl}`,
            op: 'request',
          });
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return originalHandler
        .apply(this, arguments)
        .once('response', function(this: http.IncomingMessage, res: http.ServerResponse): void {
          if (breadcrumbsEnabled) {
            addRequestBreadcrumb('response', requestUrl, this, res);
          }
          if (tracingEnabled && span) {
            span.setHttpStatus(res.statusCode);
            cleanDescription(options, this, span);
            span.finish();
          }
        })
        .once('error', function(this: http.IncomingMessage): void {
          if (breadcrumbsEnabled) {
            addRequestBreadcrumb('error', requestUrl, this);
          }
          if (tracingEnabled && span) {
            span.setHttpStatus(500);
            cleanDescription(options, this, span);
            span.finish();
          }
        });
    };
  };
}

/**
 * Captures Breadcrumb based on provided request/response pair
 */
function addRequestBreadcrumb(event: string, url: string, req: http.IncomingMessage, res?: http.ServerResponse): void {
  if (!getCurrentHub().getIntegration(Http)) {
    return;
  }

  getCurrentHub().addBreadcrumb(
    {
      category: 'http',
      data: {
        method: req.method,
        status_code: res && res.statusCode,
        url,
      },
      type: 'http',
    },
    {
      event,
      request: req,
      response: res,
    },
  );
}

/**
 * Assemble a URL to be used for breadcrumbs and spans.
 *
 * @param requestArgs URL string or object containing the component parts
 * @returns Fully-formed URL
 */
export function extractUrl(requestArgs: string | http.ClientRequestArgs): string {
  if (typeof requestArgs === 'string') {
    return stripUrlQueryAndFragment(requestArgs);
  }
  const protocol = requestArgs.protocol || '';
  const hostname = requestArgs.hostname || requestArgs.host || '';
  // Don't log standard :80 (http) and :443 (https) ports to reduce the noise
  const port = !requestArgs.port || requestArgs.port === 80 || requestArgs.port === 443 ? '' : `:${requestArgs.port}`;
  const path = requestArgs.path ? stripUrlQueryAndFragment(requestArgs.path) : '/';

  // internal routes end up with too many slashes
  return `${protocol}//${hostname}${port}${path}`.replace('///', '/');
}

/**
 * Handle an edge case with urls in the span description. Runs just before the span closes because it relies on
 * data from the response object.
 *
 * @param requestOptions Configuration data for the request
 * @param response Response object
 * @param span Span representing the request
 */
function cleanDescription(
  requestOptions: string | http.ClientRequestArgs,
  response: http.IncomingMessage,
  span: Span,
): void {
  // There are some libraries which don't pass the request protocol in the options object, so attempt to retrieve it
  // from the response and run the URL processing again. We only do this in the presence of a (non-empty) host value,
  // because if we're missing both, it's likely we're dealing with an internal route, in which case we don't want to be
  // jamming a random `http:` on the front of it.
  if (typeof requestOptions !== 'string' && !Object.keys(requestOptions).includes('protocol') && requestOptions.host) {
    // Neither http.IncomingMessage nor any of its ancestors have an `agent` property in their type definitions, and
    // http.Agent doesn't have a `protocol` property in its type definition. Nonetheless, at least one request library
    // (superagent) arranges things that way, so might as well give it a shot.
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      requestOptions.protocol = (response as any).agent.protocol;
      span.description = `${requestOptions.method || 'GET'} ${extractUrl(requestOptions)}`;
    } catch (error) {
      // well, we tried
    }
  }
}

/**
 * Checks whether given url points to Sentry server
 * @param url url to verify
 */
function isSentryRequest(url: string): boolean {
  const client = getCurrentHub().getClient();
  if (!url || !client) {
    return false;
  }

  const dsn = client.getDsn();
  if (!dsn) {
    return false;
  }

  return url.indexOf(dsn.host) !== -1;
}
