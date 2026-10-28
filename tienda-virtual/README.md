# Tienda virtual – Arquitectura de microservicios

Node.js + Express. Cada módulo es un **proceso independiente** con su **propia base de datos**.

```
                    USUARIO
                       |
                       v
              APLICACIÓN CLIENTE  (web, servida por el gateway)
                       |
                       v
               API GATEWAY :3000   (enrutamiento + circuit breaker)
          +------------+------------+
          |            |            |
          v            v            v
   PRODUCTOS :3001  CLIENTES :3002  PEDIDOS :3003
    (+ caché)                        |  consulta a Productos y Clientes
          |            |            |  con timeout, breaker y réplica local
          v            v            v
      Catálogo      Usuarios      Órdenes
   (productos.json) (clientes.json) (pedidos.json + cache-*.json)
```

## Cómo ejecutarlo en VS Code

Requisito: **Node.js 18 o superior**.

1. Abrir la carpeta en VS Code (`Archivo > Abrir carpeta`).
2. Terminal integrada (`Ctrl+ñ`):
   ```bash
   npm install
   npm start
   ```
3. Abrir <http://localhost:3000>.

Con depuración: panel *Ejecutar y depurar* (`Ctrl+Shift+D`) → **Toda la tienda (4 procesos con debugger)**.

## Validar que un módulo caído no afecta a los demás

**Automático** (levanta todo, apaga cada módulo uno a uno y verifica):
```bash
npm run test:resiliencia
```

**Manual**: con `npm start` corriendo, abre otra terminal y ejecuta cada servicio por separado
(`npm run start:productos`, etc.) en lugar de `npm start`; detén uno con `Ctrl+C` y observa en
<http://localhost:3000> cómo solo ese módulo pasa a "Sin conexión" mientras los demás siguen operando.

## Cómo se resuelven los problemas planteados

| Problema | Solución |
|---|---|
| Actualizar el catálogo afecta los pedidos | Productos y Pedidos son procesos y datos separados. |
| Lentitud en temporada de descuentos | Las consultas de catálogo se atienden solo en Productos, con caché en memoria (TTL 30 s, se invalida al modificar). El pico no toca a Pedidos ni Clientes; además Productos puede escalarse solo. |
| Una falla tumba todo | Gateway con circuit breaker y timeout: el módulo caído responde 503 rápido y los demás siguen. |
| Pedidos depende de otros módulos | Réplica local de datos mínimos + estado `PENDIENTE_VALIDACION` + reconciliador automático. |

## Comportamiento ante fallas

- **Clientes o Productos caídos**: se pueden seguir registrando pedidos de clientes/productos ya conocidos. Quedan en `PENDIENTE_VALIDACION` y pasan solos a `CONFIRMADO` (o `RECHAZADO`) cuando el módulo vuelve. Si el dato nunca se había visto, se responde `424` con un mensaje claro: no se inventan datos.
- **Pedidos caído**: el catálogo y los clientes siguen operando; el historial de pedidos no se pierde.
- Los 4xx de negocio (cliente inexistente, validaciones) no abren el circuit breaker; solo cuentan los errores de red, timeouts y 5xx.

## API (todo vía gateway `http://localhost:3000/api`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/productos?search=` | Lista/busca (cabecera `X-Cache: HIT/MISS`) |
| GET/POST/PUT/DELETE | `/productos[/:id]` | CRUD del catálogo |
| GET/POST/PUT | `/clientes[/:id]` | Gestión de clientes |
| GET | `/pedidos?clienteId=` | Lista pedidos |
| POST | `/pedidos` | `{ "clienteId": 1, "items": [{ "productoId": 1, "cantidad": 2 }] }` |
| PATCH | `/pedidos/:id/cancelar` | Cancela un pedido |
| GET | `/health` | Estado de cada módulo |

## Estructura

```
.vscode/            launch.json (depuración) y tasks.json
libs/common/        store.js (persistencia), resilience.js (breaker + timeout), server.js
services/gateway/   API gateway + aplicación cliente (public/index.html)
services/productos/ catálogo + caché
services/clientes/  usuarios
services/pedidos/   órdenes + réplica local + reconciliador
scripts/            start-all.js y test-resiliencia.js
```

## Notas de diseño y siguientes pasos

- Persistencia en archivos JSON para que funcione sin instalar nada. Para producción, cambiar `JsonStore` por PostgreSQL/MongoDB (una base por servicio); no cambia la arquitectura.
- Para producción: reemplazar la comunicación síncrona por mensajería (RabbitMQ/Kafka) para eventos como `PedidoCreado`, autenticación (JWT) en el gateway, y Docker Compose/Kubernetes para escalar Productos horizontalmente.
- El stock no se descuenta al crear un pedido; sería el primer evento a implementar con mensajería.
