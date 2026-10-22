import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request context that deep code (e.g. audit logging) can read without threading it through every call. */
export interface RequestContext {
  /** Set while a super admin is viewing the app as another user. */
  impersonatorId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
