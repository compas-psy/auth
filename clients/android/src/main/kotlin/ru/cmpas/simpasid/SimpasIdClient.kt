package ru.cmpas.simpasid

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Клиент первичного токен-API СИМПАС для мобильных приложений.
 *
 * ПОЧЕМУ ОН ЕСТЬ ОТДЕЛЬНО ОТ ВЕБ-SDK. Веб входит по OIDC с редиректом:
 * браузер уводит человека на страницу входа и возвращает с кодом. На
 * мобильном так не делают — вход идёт первичным токен-API
 * (12_NATIVE_AUTH.md). Это другой протокол, а не другой синтаксис.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ:
 *
 *   * формы входа провайдера. Приложение, собирающее пароль от Яндекса,
 *     — то, против чего придуман OAuth, и готовая схема фишинга;
 *   * встроенного webview. Он даёт приложению доступ к вводимому и к
 *     cookie провайдера;
 *   * хранения учётных данных провайдера в любом виде;
 *   * ухода в браузер: ни Custom Tab, ни мобильный веб, ни редирект.
 *
 * Порядок такой: нативный SDK провайдера отдаёт приложению код,
 * приложение отдаёт код сюда, сервер меняет его на личность. Провайдер
 * без подключённого SDK на экране НЕ ПОКАЗЫВАЕТСЯ — это следствие
 * требования, а не ошибка.
 *
 * ХРАНЕНИЕ ТОКЕНОВ СЮДА НЕ ВХОДИТ. На Android их место в
 * EncryptedSharedPreferences поверх Keystore, и это решение
 * приложения. Библиотека, знающая про хранилище, навязала бы своё —
 * а ошибка в хранении ключа входа дороже удобства.
 *
 * Доступ открыт только клиентам с first_party = true. Идентификатор
 * клиента уходит в заголовке x-client-id; чужому отвечают 403.
 *
 * ПЕРЕХВАТЧИКИ ПЕРЕДАННОГО КЛИЕНТА СНИМАЮТСЯ. Настройки транспорта —
 * таймауты, пул соединений, закрепление сертификата, прокси —
 * наследуются полностью; перехватчики нет. Причина не в чистоте:
 * в приложении обычно один OkHttpClient на всё, и его перехватчик
 * вешает ключ доступа приложения на каждый запрос. Отправить сюда
 * ключ, выданный ДРУГОЙ службой, — это выдать его службе, которая
 * его не просила; а отладочный HttpLoggingInterceptor напечатал бы
 * код из письма и токен обновления в журнал устройства.
 */
class SimpasIdClient(
    baseUrl: String,
    private val clientId: String,
    http: OkHttpClient = OkHttpClient(),
) {
    private val base = baseUrl.trimEnd('/')

    private val http: OkHttpClient = http.newBuilder()
        .apply {
            interceptors().clear()
            networkInterceptors().clear()
        }
        .build()

    /** Только для проверок: доказывает, что транспорт унаследован. */
    internal val callTimeoutMillisForTest: Int get() = http.callTimeoutMillis

    /**
     * Неизвестные поля пропускаются намеренно: сервер вправе добавить
     * поле, и старое приложение от этого падать не должно.
     */
    private val json = Json { ignoreUnknownKeys = true }

    /** Способы входа, доступные на этой платформе. */
    suspend fun authMethods(platform: Platform): AuthMethods =
        get("/v1/auth/methods?platform=${platform.wire}", AuthMethods.serializer())

    /**
     * Действующие редакции документов Экосистемы.
     *
     * Отсюда берутся номер редакции и адрес для строки, под которой
     * человек принимает Особые условия сервиса: «Начиная работу, вы
     * принимаете Особые условия ПРАКТИКИ, редакция 1.0».
     *
     * Вписывать номер редакции в приложение НЕЛЬЗЯ: он меняется без
     * выпуска новой сборки, и вписанный однажды покажет человеку не ту
     * редакцию, которую он принимает.
     *
     * Документа без опубликованной редакции в ответе нет. Для сервиса
     * это и есть ответ «подключать нечего».
     *
     * Входа не требует: документы публичны и читаются до того, как
     * человек завёл учётную запись.
     */
    suspend fun legalDocuments(): List<LegalDocument> =
        get("/v1/legal/documents", LegalDocumentList.serializer()).documents

    /**
     * Начало входа по почте. Возвращает паузу до повтора в секундах.
     *
     * На мобильном приходит КОД из письма, а не ссылка: ссылка увела бы
     * человека в почтовый клиент и браузер, откуда в приложение он уже
     * не вернётся.
     *
     * Ответ одинаков независимо от того, есть ли такая учётная запись:
     * разные ответы превратили бы это в способ узнать, зарегистрирован
     * ли человек в сервисе психологической помощи.
     */
    suspend fun startEmailAuth(
        email: String,
        deviceKey: String,
        platform: Platform,
        termsVersion: String? = null,
    ): Int = post(
        "/v1/auth/email/start",
        EmailStartRequest(email, deviceKey, platform.wire, termsVersion),
        EmailStartRequest.serializer(),
        RetryAfter.serializer(),
    ).retryAfterSeconds

    /** Обмен кода из письма на пару токенов. */
    suspend fun verifyEmailAuth(
        email: String,
        code: String,
        deviceKey: String,
        platform: Platform,
    ): TokenResponse = post(
        "/v1/auth/email/verify",
        EmailVerifyRequest(email, code, deviceKey, platform.wire),
        EmailVerifyRequest.serializer(),
        TokenResponse.serializer(),
    )

    /**
     * Обмен кода внешнего сервиса на нашу пару токенов.
     *
     * Код проверяется на сервере провайдера, а не принимается на слово,
     * и его токены после обмена не сохраняются.
     */
    /**
     * Обмен кода внешнего сервиса на нашу пару токенов.
     *
     * Код приложение получает от нативного SDK провайдера. Обмен идёт
     * НА НАШЕМ сервере: код не принимается на слово, а секрет
     * приложения у провайдера на устройстве не появляется.
     *
     * Что из необязательных полей заполнять — зависит от провайдера, и
     * приложение это знает, потому что само начинало вход:
     *
     *  * **VK ID** требует все три — `codeVerifier`, `providerDeviceId`
     *    и `state`, плюс тот же `redirectUri`, который был назван SDK.
     *    Без любого из них обмен у VK не пройдёт, и наш сервер до VK
     *    даже не пойдёт.
     *  * **Яндекс ID** обходится кодом; `codeVerifier` передаётся, если
     *    приложение использовало PKCE.
     *
     * `codeVerifier` секретом не является: это одноразовая величина
     * одной попытки входа.
     */
    suspend fun exchangeProviderCode(
        provider: String,
        providerCode: String,
        deviceKey: String,
        platform: Platform,
        codeVerifier: String? = null,
        providerDeviceId: String? = null,
        state: String? = null,
        redirectUri: String? = null,
    ): TokenResponse = post(
        "/v1/auth/provider/$provider/native",
        ProviderNativeRequest(
            providerCode, deviceKey, platform.wire,
            codeVerifier, providerDeviceId, state, redirectUri,
        ),
        ProviderNativeRequest.serializer(),
        TokenResponse.serializer(),
    )

    /**
     * Обновление пары.
     *
     * Токен обновления одноразовый. Повторное использование сервер
     * считает кражей и гасит всю цепочку — приложение обязано хранить
     * только последний выданный.
     */
    suspend fun refresh(refreshToken: String): TokenPair = post(
        "/v1/auth/token/refresh",
        RefreshRequest(refreshToken),
        RefreshRequest.serializer(),
        TokenPair.serializer(),
    )

    /** Выход. Отвечает одинаково и на чужой, и на уже погашенный токен. */
    suspend fun logout(refreshToken: String) {
        postRaw("/v1/auth/logout", RefreshRequest(refreshToken), RefreshRequest.serializer()).close()
    }

    // ── внутреннее ──────────────────────────────────────────────────

    private suspend fun <T> get(path: String, result: KSerializer<T>): T =
        parse(execute(request(path).get().build()), result)

    private suspend fun <T, B> post(
        path: String,
        body: B,
        serializer: KSerializer<B>,
        result: KSerializer<T>,
    ): T = parse(postRaw(path, body, serializer), result)

    private suspend fun <B> postRaw(
        path: String,
        body: B,
        serializer: KSerializer<B>,
    ): Response = execute(
        request(path).post(
            json.encodeToString(serializer, body).toRequestBody(JSON_MEDIA),
        ).build(),
    )

    private fun request(path: String): Request.Builder =
        Request.Builder()
            .url("$base$path".toHttpUrl())
            // Первичный токен-API открыт только своим приложениям.
            .header("x-client-id", clientId)
            .header("accept", "application/json")

    private suspend fun execute(request: Request): Response =
        withContext(Dispatchers.IO) {
            val response = http.newCall(request).execute()
            if (response.isSuccessful) return@withContext response
            // Тело читается ДО закрытия: код ошибки нужен приложению,
            // чтобы показать человеку разное на «проверьте код» и
            // «код больше не действует».
            val text = response.body?.string().orEmpty()
            val code = runCatching { json.decodeFromString(ErrorBody.serializer(), text).error }.getOrNull()
            response.close()
            // Ни адрес, ни код из письма, ни токен в сообщение не
            // попадают: оно уходит в журнал приложения, а строка
            // журнала с ключом входа равносильна выданному доступу.
            throw SimpasIdException(
                message = "СИМПАС ответил ${response.code}" + (code?.let { " ($it)" } ?: ""),
                code = code,
                status = response.code,
            )
        }

    private fun <T> parse(response: Response, result: KSerializer<T>): T =
        response.use { json.decodeFromString(result, it.body!!.string()) }

    private companion object {
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

/** Платформа клиента. Значения — те же, что в OpenAPI. */
enum class Platform(val wire: String) {
    WEB("web"), ANDROID("android"), IOS("ios"), DESKTOP("desktop")
}

/**
 * Отказ сервиса.
 *
 * `code` — машинный код из тела ответа: по нему приложение решает, что
 * показать человеку. `status` — код HTTP, на случай когда тела нет.
 */
class SimpasIdException(
    message: String,
    val code: String?,
    val status: Int,
) : RuntimeException(message)

@Serializable
data class AuthMethods(val email: Boolean, val providers: List<String> = emptyList())

@Serializable
data class LegalDocumentList(val documents: List<LegalDocument> = emptyList())

@Serializable
data class LegalDocument(
    @SerialName("document_code") val documentCode: String,
    val title: String,
    val version: String,
    /** Неизменяемый адрес ЭТОЙ редакции, относительно issuer. */
    val url: String,
    /**
     * `action` — принимается действием, содержательной кнопкой;
     * `consent` — отдельное добровольное согласие;
     * `none` — не принимается вовсе, информационный документ.
     */
    val acceptance: String,
    /** Сервис, к которому относятся Особые условия; у центральных документов — null. */
    val product: String? = null,
)

@Serializable
data class Account(
    val id: String,
    val email: String,
    @SerialName("email_verified") val emailVerified: Boolean,
    @SerialName("display_name") val displayName: String? = null,
    val products: List<String> = emptyList(),
)

@Serializable
data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Int,
    val account: Account,
)

@Serializable
data class TokenPair(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Int,
)

@Serializable
private data class RetryAfter(@SerialName("retry_after_seconds") val retryAfterSeconds: Int)

@Serializable
private data class ErrorBody(val error: String? = null)

@Serializable
private data class EmailStartRequest(
    val email: String,
    @SerialName("device_key") val deviceKey: String,
    val platform: String,
    @SerialName("terms_version") val termsVersion: String? = null,
)

@Serializable
private data class EmailVerifyRequest(
    val email: String,
    val code: String,
    @SerialName("device_key") val deviceKey: String,
    val platform: String,
)

@Serializable
private data class ProviderNativeRequest(
    @SerialName("provider_code") val providerCode: String,
    @SerialName("device_key") val deviceKey: String,
    val platform: String,
    @SerialName("code_verifier") val codeVerifier: String? = null,
    @SerialName("provider_device_id") val providerDeviceId: String? = null,
    val state: String? = null,
    @SerialName("redirect_uri") val redirectUri: String? = null,
)

@Serializable
private data class RefreshRequest(@SerialName("refresh_token") val refreshToken: String)
