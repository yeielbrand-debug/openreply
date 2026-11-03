# Port: Instagram Login (directo) → Unified login (Facebook Login for Business + SUAT)

## Por qué
Meta ya NO ofrece "API con inicio de sesión con Instagram (directo)" a apps nuevas
("no disponible en las apps más recientes"). La app nueva **YEIEL Replies**
(App ID `1642037160790904`) solo puede usar **Unified login**, que por dentro es
*Facebook Login for Business* + **token de sistema (SUAT)** que NO caduca, contra
**`graph.facebook.com`** (no `graph.instagram.com`), y **exige portfolio comercial**
(ya conectado: `yeiel__`, business_id `1397547951363281`).

OpenReply, de serie, está cableado al flujo de Instagram-login:
`www.instagram.com/oauth/authorize` + `INSTAGRAM_APP_ID`, canje en `api.instagram.com`,
y llamadas a `graph.instagram.com`. ⇒ hay que portar la capa Meta.

## Datos de la consola (YEIEL Replies)
- App ID (Facebook): `1642037160790904`
- Config de login unificado: `config_id = 2077800546956155` (token de sistema, no caduca)
- Permisos de la config: `instagram_basic`, `instagram_manage_messages`,
  `instagram_manage_comments`, `instagram_content_publish` (+ `ads_management`, `ads_read` que no usamos)
- Host de la API: `https://graph.facebook.com/{version}`
- Dominio app: `https://openreply-mu-gray.vercel.app`
- Webhook callback: `https://openreply-mu-gray.vercel.app/api/webhook`, verify token en env `WEBHOOK_VERIFY_TOKEN`

## Enfoque elegido: token por cuenta generado en la consola (cuentas propias)
Para las 3 cuentas propias de Jaime, lo más robusto y con menos código:
1. En la consola: Roles → **Instagram testers** → añadir cada @usuario → invitar.
2. Jaime **acepta** la invitación en la app de IG (Config → Apps y sitios web → Invitaciones de tester).
3. Paso 2 "Generar tokens de acceso" → **Agregar cuenta** → genera un **SUAT** por cuenta y muestra el **IG account id**.
4. Insertamos la cuenta en OpenReply con ese `{igId, SUAT, username}` (token cifrado con `ENCRYPTION_KEY`),
   vía un script `scripts/connect-meta-account.mjs` (lo corre Jaime, que tiene los secretos).

No usamos el baile OAuth de `instagram.com` ni el `config_id`/login URL (no hace falta para cuentas propias).
Si en el futuro se quieren conectar cuentas de terceros, habría que implementar el OAuth de FB-for-business
(authorize con `config_id`, canje en `graph.facebook.com/oauth/access_token`) + App Review.

## Cambios de código (checklist)
- [ ] `lib/meta/client.ts`: todas las llamadas de Instagram pasan a `graph.facebook.com`.
      (El helper `instagramGraphBase()` apunta al host de Facebook.)
- [ ] `getUserInfo`: pedir el perfil por `/{igId}?fields=username,name,profile_picture_url,followers_count`
      (ya no `/me`, que con SUAT devolvería el usuario de sistema). Pasa a recibir `igId`.
- [ ] `getUserMedia` / `getAllUserMedia`: `/{igId}/media` (ya no `/me/media`). Pasan a recibir `igId`.
- [ ] Quitar/evitar `getLongLivedToken` y `refreshLongLivedToken` (ig_exchange_token / ig_refresh_token
      son de Instagram-login; el SUAT no caduca). El cron de refresh debe saltarse las cuentas META con SUAT.
- [ ] `subscribeInstagramAccountToWebhooks`: ya hace `POST /{igId}/subscribed_apps` {comments,messages} →
      funciona igual en `graph.facebook.com`. Verificar.
- [ ] Mensajería (`/{igId}/messages` con `recipient.comment_id` y `recipient.id`, templates de botón):
      misma forma en `graph.facebook.com`. **VERIFICAR empíricamente** (es el punto con más riesgo).
- [ ] `env`: `INSTAGRAM_APP_ID` deja de ser obligatorio para conectar; añadir `FACEBOOK_APP_ID` si hace falta
      para algo (debug_token). Revisar `getMissingInstagramOAuthEnv` / rutas connect/callback.
- [ ] `scripts/connect-meta-account.mjs`: nuevo. Dado `{igId, SUAT}`: fetch perfil, subscribe webhooks,
      upsert `InstagramAccount` (provider META, token cifrado, `tokenExpiresAt=null`).
- [ ] Webhook ingest (`app/api/webhook`, `lib/meta/webhook.ts`): el `entry.id` del webhook de Instagram
      debe seguir casando con `InstagramAccount.instagramId`. **VERIFICAR** con un evento real.

## Verificación empírica (antes de dar por bueno)
Con un SUAT + igId de UNA cuenta (Jaime ejecuta, él tiene el token):
1. `GET graph.facebook.com/{ver}/{igId}?fields=username,followers_count&access_token=SUAT` → perfil OK.
2. `GET .../{igId}/media?...` → lista de posts OK.
3. Webhook de prueba (consola) → aparece fila en `WebhookEvent`.
4. Comentario real con palabra desde OTRA cuenta → llega el DM (comment→DM).

## Despliegue
- Worker (Render) tira de `jlillootaegui-ops/openreply`; Web (Vercel) de `yeielbrand-debug/openreply`.
  Al final: apuntar AMBOS al mismo fork (el que yo controlo) o empujar a los dos. Puede requerir a Jaime
  para reconectar Vercel.
