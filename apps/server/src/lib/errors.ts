import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

/** Validates input against a zod schema, turning failures into a 400 with field details. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid input", issues);
  }
  return result.data;
}
