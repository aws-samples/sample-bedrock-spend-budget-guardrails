import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

const serviceName = 'bbg';

export const logger = new Logger({ serviceName });
export const metrics = new Metrics({ namespace: 'bbg', serviceName });
export const tracer = new Tracer({ serviceName });

export { MetricUnit };
