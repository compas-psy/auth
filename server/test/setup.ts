// Тесты идут против настоящего Postgres: инварианты, неизменяемость журнала
// согласий и одноразовость токенов проверяются базой, а не заглушкой,
// и подделка здесь обесценила бы всю проверку.
process.env.DATABASE_URL ??= "postgres://simpasid:simpasid@127.0.0.1:5433/simpasid_test";
process.env.ISSUER ??= "https://auth.cmpas.ru";
process.env.NODE_ENV ??= "test";
process.env.KEYS_DIR ??= "/tmp/simpasid-test-keys";
