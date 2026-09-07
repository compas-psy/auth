/**
 * Регистрация OIDC-клиентов на боевом сервере.
 *
 * Р-3: учредитель ничего не прописывает руками. Реестр клиентов живёт
 * в базе, а не в конфигурации, поэтому нужен путь завести запись,
 * не открывая psql на боевом сервере.
 *
 * Запуск внутри контейнера — там уже есть DATABASE_URL:
 *   docker compose --project-name simpasid exec app \
 *     node dist/cli/clients.js add --id practice-web --name ПРАКТИКА \
 *       --redirect https://cmpas.ru/api/auth/callback/simpasid --product practice
 *
 * КЛЮЧ ПЕЧАТАЕТСЯ ОДИН РАЗ. Повторно его не узнать: в реестре он
 * лежит, но наружу отсюда больше не выдаётся — заново только перевыпуск.
 */
import { createClient, listClients } from "../oidc/clients.js";
import { closePool } from "../db/pool.js";
import type { Product } from "../services/accounts.js";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]!); });
  return out;
}

const USAGE = `Реестр клиентов SimpasID.

  list
  add --id <идентификатор> --name <название> [--redirect <адрес>]…
      [--product practice|zapiski|moments] [--public] [--first-party]

--public       клиент без ключа (мобильный): безопасность на PKCE
--first-party  доступ к первичному токен-API. По умолчанию НЕТ.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "list") {
    for (const c of await listClients()) {
      // Ключ не печатается: список смотрят чаще, чем заводят клиента,
      // и попадёт он не только тому, кто клиента выпускал.
      console.log([
        c.clientId, c.product ?? "—",
        c.firstParty ? "первичный" : "обычный",
        c.redirectUris.join(" ") || "—",
      ].join("\t"));
    }
    return 0;
  }

  if (command === "add") {
    const id = flag(argv, "id");
    const name = flag(argv, "name");
    if (!id || !name) { console.error(USAGE); return 2; }

    const created = await createClient({
      clientId: id,
      clientName: name,
      redirectUris: flags(argv, "redirect"),
      product: (flag(argv, "product") as Product | undefined) ?? null,
      isPublic: argv.includes("--public"),
      firstParty: argv.includes("--first-party"),
    });

    console.log(`Клиент ${created.clientId} зарегистрирован.`);
    if (created.clientSecret) {
      console.log("");
      console.log("КЛЮЧ ПОКАЗЫВАЕТСЯ ОДИН РАЗ — сохраните его сейчас:");
      console.log(created.clientSecret);
      console.log("");
      console.log("Повторно узнать его нельзя, только перевыпустить.");
    } else {
      console.log("Публичный клиент: ключ не выдаётся, вход держится на PKCE.");
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

main()
  .then(async (code) => { await closePool(); process.exit(code); })
  .catch(async (e: unknown) => {
    // Наружу — только сообщение, без стека: в стеке пути и внутреннее
    // устройство, а читать это будут в журнале прогона.
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    await closePool();
    process.exit(1);
  });
