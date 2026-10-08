/**
 * Typed failures for the contact-data path.
 *
 * Every one of these means something different to the operator, so each is its
 * own class: a missing key is a setup step, a plan error is a purchasing
 * decision, a rate limit is "wait", and a refused duplicate purchase is the
 * system working as designed. None of them is a bare `Error`.
 */

/** There is no Apollo key. Everything else in the system still works against fixtures. */
export class ApolloNotConfiguredError extends Error {
  constructor(detail = 'APOLLO_API_KEY is not set') {
    super(
      `${detail}. Create a key at Settings > Integrations > API in Apollo and put it in .env ` +
        '(docs/APOLLO-SETUP.md). Without one the contact-data path refuses to run; nothing else is affected.'
    );
    this.name = 'ApolloNotConfiguredError';
  }
}

/** Apollo answered, and the answer was a refusal or a fault. */
export class ApolloApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body: string
  ) {
    super(message);
    this.name = 'ApolloApiError';
  }
}

/** 401: the key is wrong or revoked. */
export class ApolloAuthError extends ApolloApiError {
  constructor(endpoint: string, body: string) {
    super(`Apollo rejected the API key on ${endpoint}`, 401, endpoint, body);
    this.name = 'ApolloAuthError';
  }
}

/** 403: the plan does not include the endpoint, or the key is scoped without it. */
export class ApolloPlanError extends ApolloApiError {
  constructor(endpoint: string, body: string) {
    super(
      `Apollo says this key may not call ${endpoint}: ${body.slice(0, 200)}. ` +
        'Either the plan does not include it or the key is scoped without it (npm run apollo:check).',
      403,
      endpoint,
      body
    );
    this.name = 'ApolloPlanError';
  }
}

/** 429 that outlasted every retry. */
export class ApolloRateLimitError extends ApolloApiError {
  constructor(
    endpoint: string,
    body: string,
    readonly attempts: number
  ) {
    super(`Apollo rate-limited ${endpoint} on all ${attempts} attempts`, 429, endpoint, body);
    this.name = 'ApolloRateLimitError';
  }
}

/** The network failed on every attempt, or timed out. */
export class ApolloNetworkError extends Error {
  constructor(
    readonly endpoint: string,
    cause: unknown
  ) {
    super(`could not reach Apollo at ${endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause
    });
    this.name = 'ApolloNetworkError';
  }
}

/** Apollo answered 200 with something that is not the documented shape. */
export class ApolloResponseError extends Error {
  constructor(
    readonly endpoint: string,
    detail: string
  ) {
    super(`Apollo's reply from ${endpoint} did not match the expected shape: ${detail}`);
    this.name = 'ApolloResponseError';
  }
}

/**
 * Phone numbers are delivered asynchronously to a public HTTPS URL. Asking for
 * one without that URL cannot work and would waste the credits, so it is
 * refused before the request is made.
 */
export class PhoneWebhookRequiredError extends Error {
  constructor(detail: string) {
    super(
      `phone enrichment needs a public https webhook_url (${detail}). Set PUBLIC_BASE_URL to the https address ` +
        'Apollo can reach and APOLLO_WEBHOOK_SECRET to a shared secret.'
    );
    this.name = 'PhoneWebhookRequiredError';
  }
}

/** `reveal_personal_emails` is off by default and stays off unless the client was built to allow it. */
export class PersonalEmailNotPermittedError extends Error {
  constructor() {
    super(
      'reveal_personal_emails is off by default and was not enabled for this client. It is for a high-value contact ' +
        'whose work email has bounced, and nothing else.'
    );
    this.name = 'PersonalEmailNotPermittedError';
  }
}

/** A paid call needs an Apollo person id, because that is what the never-re-buy guard keys on. */
export class MissingApolloIdError extends Error {
  constructor(detail: string) {
    super(`a paid Apollo call needs an Apollo person id so repeat purchases can be refused (${detail})`);
    this.name = 'MissingApolloIdError';
  }
}
