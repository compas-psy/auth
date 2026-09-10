import { buildServer } from "./src/index.js";
import { registerWebProvider } from "./src/services/providers/registry.js";
import { createClient, findClient } from "./src/oidc/clients.js";

const ISSUER = process.env.ISSUER!;

async function main(): Promise<void> {
  registerWebProvider({
    provider: "yandex",
    authorizationUrl: (state) =>
      `${ISSUER}/callback/yandex?code=repro-code&state=${encodeURIComponent(state)}`,
    exchange: async () => ({
      subject: "repro-subject", email: "repro@ya.ru", emailVerified: true,
    }),
  });
  if (!(await findClient("account-portal"))) {
    await createClient({
      clientId: "account-portal", clientName: "Аккаунт СИМПАС",
      redirectUris: [`${ISSUER}/account/callback`],
      product: "practice", isPublic: true,
    });
  }
  const app = await buildServer();
  await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
  console.log("готов");
}
void main();
