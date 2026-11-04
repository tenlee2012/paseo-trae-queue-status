export function formatImportErrorMessage(message: string): string {
  return message
    .replace(/^Request failed:\s*/, "")
    .replace(/\s+requestType=[\w.]+\s+code=[\w_]+$/, "");
}
