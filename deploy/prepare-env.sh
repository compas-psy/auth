#!/bin/sh
# Готовит файл .env для docker compose и убирает подготовленные имена
# из окружения оболочки.
#
# Зачем убирает. У docker compose окружение оболочки СТАРШЕ .env, и
# переменная, установленная в ПУСТОЕ, тоже старше: она молча
# перекрывает записанное в файле. Действие appleboy/ssh-action
# объявляет каждое имя из envs всегда — даже когда секрета в
# репозитории нет. На этом встала выкладка коммита 605854e:
#   required variable SIMPASID_DB_PASSWORD is missing a value
# при уже записанном в .env пароле. Единственный источник истины для
# compose — сам .env, поэтому оболочку после записи чистим.
#
# Файл СЧИТЫВАЕТСЯ текущей оболочкой:
#   . ./deploy/prepare-env.sh
# Запуск дочерним процессом бесполезен: unset остался бы в нём.
#
# Поведение проверяется тестом server/test/deploy.env.test.ts.

set -eu

SIMPASID_ENV_FILE="${SIMPASID_ENV_FILE:-.env}"
[ -f "$SIMPASID_ENV_FILE" ] || : > "$SIMPASID_ENV_FILE"
chmod 600 "$SIMPASID_ENV_FILE"

# Запись без sed: секрет провайдера вправе содержать '|', '&' и
# обратную косую, а замена «s|^KEY=.*|KEY=$value|» на них ломается —
# молча, испорченным значением. Строку удаляем целиком и дописываем
# заново, значение при этом нигде не разбирается как выражение.
simpasid_put() {
  if [ -s "$SIMPASID_ENV_FILE" ]; then
    grep -v "^$1=" "$SIMPASID_ENV_FILE" > "$SIMPASID_ENV_FILE.tmp" || :
    mv "$SIMPASID_ENV_FILE.tmp" "$SIMPASID_ENV_FILE"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$SIMPASID_ENV_FILE"
}

# Все имена, которые compose читает из .env. Пустое значение НЕ
# записывается: оно затёрло бы уже работающее.
# VKID_CLIENT_ID без пары: обмен кода у VK идёт БЕЗ секрета приложения —
# защита держится на PKCE и зарегистрированном адресе возврата. Секрет,
# который негде применить, на сервере не нужен.
#
# VKID_NATIVE_CLIENT_ID — идентификатор ОТДЕЛЬНОГО приложения VK под
# мобильную платформу. Необязателен: пока приложение одно на все
# платформы, мобильный вход берёт тот же идентификатор, что и веб.
for simpasid_key in \
  SIMPASID_DB_PASSWORD YANDEX_CLIENT_ID YANDEX_CLIENT_SECRET \
  VKID_CLIENT_ID VKID_NATIVE_CLIENT_ID \
  MAIL_ENDPOINT MAIL_TOKEN
do
  eval "simpasid_value=\${$simpasid_key:-}"
  [ -z "$simpasid_value" ] || simpasid_put "$simpasid_key" "$simpasid_value"
  unset "$simpasid_key"
done

# Пароль базы обязателен: без него compose не соберёт строку
# подключения. Заводится ОДИН раз и дальше живёт на сервере — смена
# пароля отрезала бы приложение от собственной базы. Точка в шаблоне
# требует непустого значения: строка «=» считается отсутствующей.
if ! grep -q '^SIMPASID_DB_PASSWORD=.' "$SIMPASID_ENV_FILE"; then
  simpasid_put SIMPASID_DB_PASSWORD "$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
fi

chmod 600 "$SIMPASID_ENV_FILE"
unset simpasid_key simpasid_value SIMPASID_ENV_FILE
