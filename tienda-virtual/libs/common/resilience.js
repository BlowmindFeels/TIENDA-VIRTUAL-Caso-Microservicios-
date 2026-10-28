// Utilidades de resiliencia: timeout + Circuit Breaker para llamadas entre servicios.
// Si un servicio remoto cae, el que lo llama falla RÁPIDO en lugar de quedarse colgado,
// y así no arrastra consigo al resto del sistema.

class ServiceUnavailableError extends Error {
  constructor(service, reason) {
    super(`Servicio "${service}" no disponible (${reason})`);
    this.name = 'ServiceUnavailableError';
    this.service = service;
    this.unavailable = true;
  }
}

class CircuitBreaker {
  constructor({ name, failureThreshold = 3, resetMs = 5000 }) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetMs = resetMs;
    this.state = 'CLOSED'; // CLOSED = normal | OPEN = bloqueado | HALF_OPEN = probando
    this.failures = 0;
    this.openedAt = 0;
  }
  async exec(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.resetMs) this.state = 'HALF_OPEN';
      else throw new ServiceUnavailableError(this.name, 'circuito abierto');
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'CLOSED';
      return result;
    } catch (err) {
      if (err.unavailable) {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
          this.state = 'OPEN';
          this.openedAt = Date.now();
        }
      }
      throw err;
    }
  }
}

// Llamada HTTP con timeout. Errores de red y respuestas 5xx => ServiceUnavailableError.
// Respuestas 4xx se devuelven normalmente (son errores de negocio, no de disponibilidad).
async function requestJson(service, url, { method = 'GET', body, timeoutMs = 2000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ServiceUnavailableError(service, e.name === 'TimeoutError' ? 'timeout' : 'sin conexión');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (res.status >= 500) throw new ServiceUnavailableError(service, `HTTP ${res.status}`);
  return { status: res.status, data, headers: res.headers };
}

module.exports = { CircuitBreaker, ServiceUnavailableError, requestJson };
