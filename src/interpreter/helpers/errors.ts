/**
 * Error helper functions for the interpreter.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract message from an unknown error value.
 * Handles both Error instances and other thrown values.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isRecord(error)) {
    const message = error.message;
    const name = error.name;

    if (typeof message === "string" && message.length > 0) {
      if (typeof name === "string" && name.length > 0 && name !== "Error") {
        return `${name}: ${message}`;
      }
      return message;
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") {
        return json;
      }
    } catch {
      // Fall back to constructor/string handling below.
    }

    const constructorName = error.constructor?.name;
    if (typeof constructorName === "string" && constructorName.length > 0) {
      return constructorName === "Object"
        ? String(error)
        : `[${constructorName}] ${String(error)}`;
    }
  }

  return String(error);
}
