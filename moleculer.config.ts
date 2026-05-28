'use strict';
import { BrokerOptions, Errors, ServiceBroker } from 'moleculer';

const brokerConfig: BrokerOptions = {
  namespace: '',
  nodeID: null,
  metadata: {},
  logger: {
    type: 'Console',
    options: {
      colors: true,
      moduleColors: false,
      formatter: 'full',
      objectPrinter: null,
      autoPadding: false,
    },
  },
  logLevel: 'info',
  transporter: null,
  // MVP runs without Redis. When/if caching is needed, replace with:
  //   { type: 'Redis', options: { redis: process.env.REDIS_CONNECTION, prefix: 'stalu', ttl: 3600 } }
  cacher: null,
  serializer: 'JSON',
  requestTimeout: 10 * 1000,
  retryPolicy: {
    enabled: false,
    retries: 5,
    delay: 100,
    maxDelay: 1000,
    factor: 2,
    check: ((err: Errors.MoleculerError) => Boolean(err && err.retryable)) as any,
  },
  maxCallLevel: 100,
  heartbeatInterval: 10,
  heartbeatTimeout: 30,
  contextParamsCloning: false,
  tracking: {
    enabled: false,
    shutdownTimeout: 5000,
  },
  disableBalancer: false,
  registry: {
    strategy: 'RoundRobin',
    preferLocal: true,
  },
  circuitBreaker: {
    enabled: false,
    threshold: 0.5,
    minRequestCount: 20,
    windowTime: 60,
    halfOpenTime: 10 * 1000,
    check: ((err: Errors.MoleculerError) => Boolean(err && err.code >= 500)) as any,
  },
  bulkhead: {
    enabled: false,
    concurrency: 10,
    maxQueueSize: 100,
  },
  validator: true,
  errorHandler: undefined,
  metrics: {
    enabled: false,
  },
  tracing: {
    enabled: false,
  },
  middlewares: [],
  created: async (_broker: ServiceBroker): Promise<void> => {},
};

export = brokerConfig;
