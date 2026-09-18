/**
 * `issuer`/`audience` del access token — un solo lugar (collaboration-gateway/
 * design.md §D4). Antes de esta rebanada, los mismos dos literales vivían
 * duplicados en `tokens.service.ts` (`ISS`/`AUD`) y `jwt.strategy.ts` (inline
 * en el constructor de `PassportStrategy`). `SocketAuthService` suma un
 * tercer lugar que verifica exactamente el mismo token — sumar un tercer
 * literal es pedir que los tres se separen. Valores idénticos a los que ya
 * estaban: el cambio preserva comportamiento por construcción.
 */
export const JWT_ACCESS_ISSUER = 'umlive';
export const JWT_ACCESS_AUDIENCE = 'umlive-web';
