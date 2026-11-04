import { describe, expect, it } from "vitest";
import { formatImportErrorMessage } from "./workspace-import-error.js";

describe("workspace import errors", () => {
  it("shows the actionable native error without RPC transport metadata", () => {
    expect(
      formatImportErrorMessage(
        "Request failed: 该会话仍被 TRAE CLI 或其他客户端占用，请先关闭原会话后重试导入。 requestType=plugin.rpc.invoke.request code=handler_error",
      ),
    ).toBe("该会话仍被 TRAE CLI 或其他客户端占用，请先关闭原会话后重试导入。");
  });
  it("preserves error details that do not use the daemon RPC envelope", () => {
    expect(formatImportErrorMessage("TRAE CLI startup timed out after 10s")).toBe(
      "TRAE CLI startup timed out after 10s",
    );
  });
});
