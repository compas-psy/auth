// Тесты идут против настоящего Postgres: инварианты, неизменяемость журнала
// согласий и одноразовость токенов проверяются базой, а не заглушкой,
// и подделка здесь обесценила бы всю проверку.
process.env.DATABASE_URL ??= "postgres://simpasid:simpasid@127.0.0.1:5433/simpasid_test";
process.env.ISSUER ??= "https://auth.cmpas.ru";
process.env.NODE_ENV ??= "test";
process.env.KEYS_DIR ??= "/tmp/simpasid-test-keys";

// Тексты юридических документов лежат файлами в репозитории, и Dockerfile
// кладёт тот же каталог в /app/legal. Тест, который их не видит, проверяет
// не сервис, а пустую папку: страница редакции честно скажет «текст ещё не
// опубликован» — и приёмка Т-4 пройдёт мимо настоящего документа.
process.env.LEGAL_TEXTS_DIR ??= new URL("../../legal", import.meta.url).pathname;
