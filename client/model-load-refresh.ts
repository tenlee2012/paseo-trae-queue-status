import type { PluginClientContext } from "@getpaseo/plugin/client";

export function refreshModelLoads(
  providers: Pick<PluginClientContext["paseo"]["providers"], "refresh">,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(() => {
      void refresh()
        .catch((error: unknown) => {
          if (!disposed) console.warn("TRAE model menu refresh failed", error);
        })
        .finally(() => {
          if (!disposed) schedule();
        });
    }, 30_000);
  };
  const refresh = async () => {
    await providers.refresh({ providers: ["traecli-queue"] });
  };
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
