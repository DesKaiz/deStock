
// @ts-expect-error Bu dosya OpenNext derlemesi sırasında oluşturulur.
import handler from "./.open-next/worker.js";

interface Env {
  WORKER_SELF_REFERENCE: {
    fetch(request: Request): Promise<Response>;
  };
  CLOSURE_RECOVERY_TOKEN: string;
}

export default {
  fetch: handler.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
  ) {
    const response = await env.WORKER_SELF_REFERENCE.fetch(
      new Request(
        "https://destock.deskaiz.com.tr/api/organization/close/recover",
        {
          method: "POST",
          headers: {
            "x-closure-recovery-token": env.CLOSURE_RECOVERY_TOKEN,
          },
        },
      ),
    );

    if (!response.ok) {
      throw new Error(`Kurtarma isteği başarısız: ${response.status}`);
    }

    console.log("İşletme kapatma kurtarma kontrolü tamamlandı.");
  },
};

// @ts-expect-error Bu dosya OpenNext derlemesi sırasında oluşturulur.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
