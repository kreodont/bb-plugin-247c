export class PolicyError extends Error {
  readonly code = "POLICY_REJECTED";
}

export class ConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
}
