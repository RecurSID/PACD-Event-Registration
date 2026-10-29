import { SEAT_LIMITS } from '../public/shared/constants.js';

export class AppError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const RECORD_GONE = 'That record no longer exists. Refresh and try again.';
// 23503: foreign-key race (an organisation removed mid-request); a retry gets a clear answer.
const RETRYABLE_PG_CODES = new Set(['40P01', '40001', '55P03', '57014', '23503']);

export const errors = {
  validation: (fields) => new AppError('VALIDATION', 400, 'Please check the highlighted fields.', { fields }),
  unauthorised: (message = 'Please log in again.') => new AppError('UNAUTHORISED', 401, message),
  notFound: (message = RECORD_GONE) => new AppError('NOT_FOUND', 404, message),
  conflict: (message) => new AppError('CONFLICT', 409, message),
  dbUnavailable: () => new AppError('DB_UNAVAILABLE', 503, 'Service is busy, please try again in a moment.'),
  maintenance: () => new AppError('MAINTENANCE', 503, 'The site is down for scheduled maintenance. Please try again shortly.'),
  internal: (cause) => Object.assign(new AppError('INTERNAL', 500, 'Something went wrong, please try again.'), { cause }),
};

function parseDetails(details) {
  try {
    return JSON.parse(details) ?? {};
  } catch {
    return {};
  }
}

export function fromDbError(error) {
  switch (error?.message) {
    case 'VALIDATION':
      return errors.validation({ [error.details || 'form']: 'Invalid value.' });
    case 'NOT_FOUND':
      return errors.notFound();
    case 'ORG_NOT_FOUND':
      return new AppError('ORG_NOT_FOUND', 404, RECORD_GONE);
    case 'SEAT_FULL': {
      const { side, orgs = [] } = parseDetails(error.details);
      return new AppError(
        'SEAT_FULL',
        409,
        `Already full (${side} limit ${SEAT_LIMITS[side]}): ${orgs.join('; ')}. Remove them or contact the event team.`,
      );
    }
    case 'DUPLICATE_EMAIL':
      return new AppError('DUPLICATE_EMAIL', 409, 'This email is already registered. Contact the event team to change it.');
    case 'MERGE_OVER_LIMIT': {
      const { target, side, count } = parseDetails(error.details);
      return new AppError(
        'MERGE_OVER_LIMIT',
        409,
        `${target} would have ${count} ${side} attendees (limit ${SEAT_LIMITS[side]}). Merge anyway?`,
        { count },
      );
    }
    default: {
      // supabase-js reports network failures with an empty code.
      if (!error?.code || RETRYABLE_PG_CODES.has(error.code)) {
        return Object.assign(errors.dbUnavailable(), { cause: error });
      }
      return errors.internal(error);
    }
  }
}

// Express error middleware: the 4-argument signature is required.
export function errorHandler(err, req, res, next) {
  let appError = err;
  if (typeof err?.type === 'string' && err.type.startsWith('entity.')) {
    appError = errors.validation({ form: 'Invalid request body.' });
  } else if (!(err instanceof AppError)) {
    appError = errors.internal(err);
  }
  if (appError.status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, appError.cause ?? appError);
  }
  // A streamed download may have already sent its headers. Delegate so Express closes the
  // incomplete response instead of attempting to append a JSON error to a PDF stream.
  if (res.headersSent) return next(err);
  res.status(appError.status).json({ error: appError.code, message: appError.message, ...appError.extra });
}
