import { BrowserClient } from '@sentry/browser';
import { Hub, Scope } from '@sentry/hub';

import { Span, SpanStatus, Transaction } from '../src';
import { TRACEPARENT_REGEXP } from '../src/utils';

describe('Span', () => {
  let hub: Hub;

  beforeEach(() => {
    const myScope = new Scope();
    hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }), myScope);
  });

  describe('new Span', () => {
    test('simple', () => {
      const span = new Span({ sampled: true });
      const span2 = span.startChild();
      expect((span2 as any).parentSpanId).toBe((span as any).spanId);
      expect((span2 as any).traceId).toBe((span as any).traceId);
      expect((span2 as any).sampled).toBe((span as any).sampled);
    });
  });

  describe('new Transaction', () => {
    test('simple', () => {
      const transaction = new Transaction({ name: 'test', sampled: true });
      const span2 = transaction.startChild();
      expect((span2 as any).parentSpanId).toBe((transaction as any).spanId);
      expect((span2 as any).traceId).toBe((transaction as any).traceId);
      expect((span2 as any).sampled).toBe((transaction as any).sampled);
    });

    test('gets currentHub', () => {
      const transaction = new Transaction({ name: 'test' });
      expect((transaction as any)._hub).toBeInstanceOf(Hub);
    });

    test('inherit span list', () => {
      const transaction = new Transaction({ name: 'test', sampled: true });
      const span2 = transaction.startChild();
      const span3 = span2.startChild();
      span3.finish();
      expect(transaction.spanRecorder).toBe(span2.spanRecorder);
      expect(transaction.spanRecorder).toBe(span3.spanRecorder);
    });
  });

  describe('setters', () => {
    test('setTag', () => {
      const span = new Span({});
      expect(span.tags.foo).toBeUndefined();
      span.setTag('foo', 'bar');
      expect(span.tags.foo).toBe('bar');
      span.setTag('foo', 'baz');
      expect(span.tags.foo).toBe('baz');
    });

    test('setData', () => {
      const span = new Span({});
      expect(span.data.foo).toBeUndefined();
      span.setData('foo', null);
      expect(span.data.foo).toBe(null);
      span.setData('foo', 2);
      expect(span.data.foo).toBe(2);
      span.setData('foo', true);
      expect(span.data.foo).toBe(true);
    });
  });

  describe('status', () => {
    test('setStatus', () => {
      const span = new Span({});
      span.setStatus(SpanStatus.PermissionDenied);
      expect((span.getTraceContext() as any).status).toBe('permission_denied');
    });

    test('setHttpStatus', () => {
      const span = new Span({});
      span.setHttpStatus(404);
      expect((span.getTraceContext() as any).status).toBe('not_found');
      expect(span.tags['http.status_code']).toBe('404');
    });

    test('isSuccess', () => {
      const span = new Span({});
      expect(span.isSuccess()).toBe(false);
      span.setHttpStatus(200);
      expect(span.isSuccess()).toBe(true);
      span.setStatus(SpanStatus.PermissionDenied);
      expect(span.isSuccess()).toBe(false);
    });
  });

  describe('toTraceparent', () => {
    test('simple', () => {
      expect(new Span().toTraceparent()).toMatch(TRACEPARENT_REGEXP);
    });
    test('with sample', () => {
      expect(new Span({ sampled: true }).toTraceparent()).toMatch(TRACEPARENT_REGEXP);
    });
  });

  describe('toJSON', () => {
    test('simple', () => {
      const span = JSON.parse(
        JSON.stringify(new Span({ traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb' })),
      );
      expect(span).toHaveProperty('span_id', 'bbbbbbbbbbbbbbbb');
      expect(span).toHaveProperty('trace_id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    test('with parent', () => {
      const spanA = new Span({ traceId: 'a', spanId: 'b' }) as any;
      const spanB = new Span({ traceId: 'c', spanId: 'd', sampled: false, parentSpanId: spanA.spanId });
      const serialized = JSON.parse(JSON.stringify(spanB));
      expect(serialized).toHaveProperty('parent_span_id', 'b');
      expect(serialized).toHaveProperty('span_id', 'd');
      expect(serialized).toHaveProperty('trace_id', 'c');
    });

    test('should drop all `undefined` values', () => {
      const spanA = new Span({ traceId: 'a', spanId: 'b' }) as any;
      const spanB = new Span({
        parentSpanId: spanA.spanId,
        spanId: 'd',
        traceId: 'c',
      });
      const serialized = spanB.toJSON();
      expect(serialized).toHaveProperty('start_timestamp');
      delete (serialized as { start_timestamp: number }).start_timestamp;
      expect(serialized).toStrictEqual({
        parent_span_id: 'b',
        span_id: 'd',
        trace_id: 'c',
      });
    });
  });

  describe('finish', () => {
    test('simple', () => {
      const span = new Span({});
      expect(span.endTimestamp).toBeUndefined();
      span.finish();
      expect(span.endTimestamp).toBeGreaterThan(1);
    });

    describe('hub.startTransaction', () => {
      test('finish a transaction', () => {
        const spy = jest.spyOn(hub as any, 'captureEvent') as any;
        const transaction = hub.startTransaction({ name: 'test' });
        transaction.finish();
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0].spans).toHaveLength(0);
        expect(spy.mock.calls[0][0].timestamp).toBeTruthy();
        expect(spy.mock.calls[0][0].start_timestamp).toBeTruthy();
        expect(spy.mock.calls[0][0].contexts.trace).toEqual(transaction.getTraceContext());
      });

      test('finish a transaction + child span', () => {
        const spy = jest.spyOn(hub as any, 'captureEvent') as any;
        const transaction = hub.startTransaction({ name: 'test' });
        const childSpan = transaction.startChild();
        childSpan.finish();
        transaction.finish();
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0].spans).toHaveLength(1);
        expect(spy.mock.calls[0][0].contexts.trace).toEqual(transaction.getTraceContext());
      });

      test("finish a child span shouldn't trigger captureEvent", () => {
        const spy = jest.spyOn(hub as any, 'captureEvent') as any;
        const transaction = hub.startTransaction({ name: 'test' });
        const childSpan = transaction.startChild();
        childSpan.finish();
        expect(spy).not.toHaveBeenCalled();
      });

      test("finish a span with another one on the scope shouldn't override contexts.trace", () => {
        const spy = jest.spyOn(hub as any, 'captureEvent') as any;
        const transaction = hub.startTransaction({ name: 'test' });
        const childSpanOne = transaction.startChild();
        childSpanOne.finish();

        hub.configureScope(scope => {
          scope.setSpan(childSpanOne);
        });

        const spanTwo = transaction.startChild();
        spanTwo.finish();
        transaction.finish();

        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0].spans).toHaveLength(2);
        expect(spy.mock.calls[0][0].contexts.trace).toEqual(transaction.getTraceContext());
      });

      test('span child limit', () => {
        const _hub = new Hub(
          new BrowserClient({
            _experiments: { maxSpans: 3 },
            tracesSampleRate: 1,
          }),
        );
        const spy = jest.spyOn(_hub as any, 'captureEvent') as any;
        const transaction = _hub.startTransaction({ name: 'test' });
        for (let i = 0; i < 10; i++) {
          const child = transaction.startChild();
          child.finish();
        }
        transaction.finish();
        expect(spy.mock.calls[0][0].spans).toHaveLength(3);
      });

      test('if we sampled the transaction we do not want any children', () => {
        const _hub = new Hub(
          new BrowserClient({
            tracesSampleRate: 0,
          }),
        );
        const spy = jest.spyOn(_hub as any, 'captureEvent') as any;
        const transaction = _hub.startTransaction({ name: 'test' });
        for (let i = 0; i < 10; i++) {
          const child = transaction.startChild();
          child.finish();
        }
        transaction.finish();
        expect((transaction as any).spanRecorder).toBeUndefined();
        expect(spy).not.toHaveBeenCalled();
      });

      test('mixing hub.startSpan(transaction) + span.startChild + maxSpans', () => {
        const _hub = new Hub(
          new BrowserClient({
            _experiments: { maxSpans: 2 },
            tracesSampleRate: 1,
          }),
        );
        const spy = jest.spyOn(_hub as any, 'captureEvent') as any;

        const transaction = _hub.startTransaction({ name: 'test' });
        const childSpanOne = transaction.startChild({ op: '1' });
        childSpanOne.finish();

        _hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const spanTwo = transaction.startChild({ op: '2' });
        spanTwo.finish();

        const spanThree = transaction.startChild({ op: '3' });
        spanThree.finish();

        transaction.finish();

        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0].spans).toHaveLength(2);
      });

      test('tree structure of spans should be correct when mixing it with span on scope', () => {
        const spy = jest.spyOn(hub as any, 'captureEvent') as any;

        const transaction = hub.startTransaction({ name: 'test' });
        const childSpanOne = transaction.startChild();

        const childSpanTwo = childSpanOne.startChild();
        childSpanTwo.finish();

        childSpanOne.finish();

        hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const spanTwo = transaction.startChild({});
        spanTwo.finish();
        transaction.finish();

        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][0].spans).toHaveLength(3);
        expect(spy.mock.calls[0][0].contexts.trace).toEqual(transaction.getTraceContext());
        expect(childSpanOne.toJSON().parent_span_id).toEqual(transaction.toJSON().span_id);
        expect(childSpanTwo.toJSON().parent_span_id).toEqual(childSpanOne.toJSON().span_id);
        expect(spanTwo.toJSON().parent_span_id).toEqual(transaction.toJSON().span_id);
      });
    });
  });

  describe('getTraceContext', () => {
    test('should have status attribute undefined if no status tag is available', () => {
      const span = new Span({});
      const context = span.getTraceContext();
      expect((context as any).status).toBeUndefined();
    });

    test('should have success status extracted from tags', () => {
      const span = new Span({});
      span.setStatus(SpanStatus.Ok);
      const context = span.getTraceContext();
      expect((context as any).status).toBe('ok');
    });

    test('should have failure status extracted from tags', () => {
      const span = new Span({});
      span.setStatus(SpanStatus.ResourceExhausted);
      const context = span.getTraceContext();
      expect((context as any).status).toBe('resource_exhausted');
    });

    test('should drop all `undefined` values', () => {
      const spanB = new Span({ spanId: 'd', traceId: 'c' });
      const context = spanB.getTraceContext();
      expect(context).toStrictEqual({
        span_id: 'd',
        trace_id: 'c',
      });
    });
  });
});
