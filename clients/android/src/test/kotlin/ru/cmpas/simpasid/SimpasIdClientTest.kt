package ru.cmpas.simpasid

import kotlinx.coroutines.test.runTest
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.DisplayName
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Клиент первичного токен-API проверяется против настоящего HTTP,
 * а не против заглушки: MockWebServer принимает запрос целиком, и
 * видно, что именно ушло в сеть.
 */
/*
 * Имена проверок латиницей, а человеческое название — в @DisplayName.
 * Причина не в стиле: имя в обратных кавычках попадает в имя файла
 * класса лямбды, и на машине без UTF-8 в локали сборка падает ещё до
 * первой проверки. Отчёт при этом остаётся на русском.
 */
class SimpasIdClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: SimpasIdClient

    @BeforeTest fun setUp() {
        server = MockWebServer()
        server.start()
        client = SimpasIdClient(
            baseUrl = server.url("/").toString(),
            clientId = "practice-mobile",
        )
    }

    @AfterTest fun tearDown() = server.shutdown()

    private fun json(code: Int, body: String) =
        server.enqueue(MockResponse().setResponseCode(code)
            .setHeader("content-type", "application/json").setBody(body))

    @Test
    @DisplayName("клиент называет себя в каждом запросе")
    fun client_names_itself_in_every_request() = runTest {
        // Без x-client-id первичный токен-API отвечает 403: он открыт
        // только своим приложениям. Забыть заголовок значит получить
        // отказ, причина которого на экране не видна.
        json(200, """{"email":true,"providers":["yandex"]}""")
        client.authMethods(Platform.ANDROID)
        assertEquals("practice-mobile", server.takeRequest().getHeader("x-client-id"))
    }

    @Test
    @DisplayName("состав способов входа разбирается")
    fun auth_methods_are_parsed() = runTest {
        json(200, """{"email":true,"providers":["yandex"]}""")
        val methods = client.authMethods(Platform.ANDROID)
        assertTrue(methods.email)
        assertEquals(listOf("yandex"), methods.providers)
    }

    @Test
    @DisplayName("пустой список провайдеров — не ошибка")
    fun empty_provider_list_is_not_an_error() = runTest {
        // Провайдер без подключённого нативного SDK на мобильном экране
        // не показывается. Это следствие требования, а не поломка.
        json(200, """{"email":true,"providers":[]}""")
        assertTrue(client.authMethods(Platform.ANDROID).providers.isEmpty())
    }

    @Test
    @DisplayName("начало входа по почте отправляет то, что ждёт сервер")
    fun email_start_sends_what_the_server_expects() = runTest {
        json(202, """{"retry_after_seconds":60}""")
        val pause = client.startEmailAuth(
            email = "t@ya.ru", deviceKey = "dev-1",
            platform = Platform.ANDROID, termsVersion = "0.9",
        )
        assertEquals(60, pause)
        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains(""""email":"t@ya.ru""""))
        assertTrue(body.contains(""""device_key":"dev-1""""))
        assertTrue(body.contains(""""platform":"android""""))
    }

    @Test
    @DisplayName("код из письма меняется на пару токенов и учётную запись")
    fun email_code_is_exchanged_for_tokens_and_account() = runTest {
        json(200, """{"access_token":"at","refresh_token":"rt","expires_in":900,
            "account":{"id":"acc-1","email":"t@ya.ru","email_verified":true,"products":["practice"]}}""")
        val tokens = client.verifyEmailAuth("t@ya.ru", "123456", "dev-1", Platform.ANDROID)
        assertEquals("at", tokens.accessToken)
        assertEquals(900, tokens.expiresIn)
        assertEquals("acc-1", tokens.account.id)
        assertTrue(tokens.account.emailVerified)
    }

    @Test
    @DisplayName("код провайдера уходит на адрес этого провайдера")
    fun provider_code_goes_to_that_providers_path() = runTest {
        json(200, """{"access_token":"at","refresh_token":"rt","expires_in":900,
            "account":{"id":"acc-1","email":"t@ya.ru","email_verified":true,"products":[]}}""")
        client.exchangeProviderCode("yandex", "prov-code", "dev-1", Platform.ANDROID)
        assertEquals("/v1/auth/provider/yandex/native", server.takeRequest().path)
    }

    @Test
    @DisplayName("обновление отдаёт новую пару")
    fun refresh_returns_a_new_pair() = runTest {
        json(200, """{"access_token":"at2","refresh_token":"rt2","expires_in":900}""")
        val pair = client.refresh("rt1")
        assertEquals("at2", pair.accessToken)
        assertEquals("rt2", pair.refreshToken)
    }

    @Test
    @DisplayName("выход не падает на пустом ответе")
    fun logout_survives_an_empty_response() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        client.logout("rt1")
    }

    @Test
    @DisplayName("чужому клиенту отвечают отказом, и это видно по коду")
    fun foreign_client_is_refused_with_a_readable_code() = runTest {
        json(403, """{"error":"forbidden_client"}""")
        val e = assertFailsWith<SimpasIdException> { client.authMethods(Platform.ANDROID) }
        assertEquals("forbidden_client", e.code)
        assertEquals(403, e.status)
    }

    @Test
    @DisplayName("неверный код отличим от исчерпанных попыток")
    fun wrong_code_differs_from_spent_attempts() = runTest {
        // Приложению нужно показать разное: «проверьте код» и «код
        // больше не действует, запросите новый».
        json(400, """{"error":"invalid_code"}""")
        val wrong = assertFailsWith<SimpasIdException> {
            client.verifyEmailAuth("t@ya.ru", "000000", "dev-1", Platform.ANDROID) }
        assertEquals("invalid_code", wrong.code)

        json(429, """{"error":"too_many_attempts"}""")
        val spent = assertFailsWith<SimpasIdException> {
            client.verifyEmailAuth("t@ya.ru", "000000", "dev-1", Platform.ANDROID) }
        assertEquals("too_many_attempts", spent.code)
    }

    @Test
    @DisplayName("ответ без разбираемого тела не роняет клиент")
    fun unparseable_body_does_not_break_the_client() = runTest {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>502</html>"))
        val e = assertFailsWith<SimpasIdException> { client.authMethods(Platform.ANDROID) }
        assertEquals(502, e.status)
    }

    @Test
    @DisplayName("ни токен, ни код, ни адрес не попадают в сообщение об ошибке")
    fun no_token_code_or_address_in_the_error_message() = runTest {
        // Сообщение исключения уходит в журнал приложения. Токен в нём
        // равносилен выданному доступу, адрес — это персональные данные.
        json(400, """{"error":"invalid_code"}""")
        val e = assertFailsWith<SimpasIdException> {
            client.verifyEmailAuth("человек@ya.ru", "123456", "dev-1", Platform.ANDROID) }
        val text = "${e.message} ${e.stackTraceToString()}"
        assertFalse(text.contains("человек@ya.ru"))
        assertFalse(text.contains("123456"))
    }

    /**
     * У ПРАКТИКИ один OkHttpClient на всё приложение, и его
     * AuthInterceptor вешает СВОЙ Bearer на КАЖДЫЙ запрос, а в отладочной
     * сборке пишет тела целиком в logcat (проверено чтением
     * android/app/src/main/java/ru/cmpas/app/di/NetworkModule.kt и
     * data/api/AuthInterceptor.kt, 07.09.2026).
     *
     * Передать такой клиент сюда значит отправить ключ доступа ПРАКТИКИ
     * на auth.cmpas.ru — чужой службе, которая его не просила, — и
     * напечатать код из письма в журнал устройства. Настройки транспорта
     * (таймауты, пул, закрепление сертификата) наследуются, перехватчики
     * — нет.
     */
    @Test
    @DisplayName("чужой перехватчик не доносит до СИМПАС ключ другого сервиса")
    fun foreign_interceptor_cannot_leak_another_services_token() = runTest {
        val theirs = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                chain.proceed(chain.request().newBuilder()
                    .addHeader("Authorization", "Bearer practice-token")
                    .build())
            })
            .build()
        val client = SimpasIdClient(server.url("/").toString(), "practice-mobile", theirs)

        json(200, """{"email":true,"providers":[]}""")
        client.authMethods(Platform.ANDROID)

        val sent = server.takeRequest()
        assertEquals(null, sent.getHeader("Authorization"))
        assertEquals("practice-mobile", sent.getHeader("x-client-id"))
    }

    @Test
    @DisplayName("настройки транспорта у переданного клиента сохраняются")
    fun transport_settings_of_a_supplied_client_are_kept() = runTest {
        val theirs = OkHttpClient.Builder()
            .callTimeout(java.time.Duration.ofSeconds(17))
            .build()
        val client = SimpasIdClient(server.url("/").toString(), "practice-mobile", theirs)
        json(200, """{"email":true,"providers":[]}""")
        client.authMethods(Platform.ANDROID)
        assertEquals(17_000, client.callTimeoutMillisForTest)
    }

    @Test
    @DisplayName("адрес сервиса с косой чертой на конце не ломает пути")
    fun trailing_slash_in_base_url_does_not_break_paths() = runTest {
        val withSlash = SimpasIdClient(server.url("/").toString(), "practice-mobile")
        json(200, """{"email":true,"providers":[]}""")
        withSlash.authMethods(Platform.WEB)
        assertEquals("/v1/auth/methods?platform=web", server.takeRequest().path)
    }
}
