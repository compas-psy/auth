#!/bin/sh
#
# Ровно те команды, что стоят в .github/workflows/build.yml, и в том же
# порядке. Запускать ПЕРЕД слиянием, а не после.
#
# Почему файл существует. 11.09.2026 я дважды уронил main, и оба раза
# одинаково: прогнал «почти всё». В первый раз не запустил набор
# пакетов и сломал проверку рецепта; во второй прогнал тайпчек только
# сервера, а CI проверяет типы четырёх пакетов.
#
# Память об этом списке — плохая проверка. Список — хорошая.
set -e
cd "$(dirname "$0")/.."

for p in server portal devsite packages/id-client; do
  printf '%-22s типы: ' "$p"
  if npm run typecheck --prefix "$p" >/tmp/типы.log 2>&1; then
    echo чисто
  else
    echo ПАДАЮТ; tail -8 /tmp/типы.log; exit 1
  fi
done

printf '%-22s ' "портал"
npm run build --prefix portal >/dev/null 2>&1 && echo "собрался"

for p in server portal devsite packages/id-client; do
  printf '%-22s ' "$p"
  npm test --prefix "$p" 2>&1 | grep -E "^ +Tests " | tail -1
done

echo
echo "Чего здесь НЕТ и что гоняет CI отдельно:"
echo "  • котлин-клиент — gradle test --console=plain в clients/android"
echo "  • сборка образа и браузерная проверка входа — нужен docker"
