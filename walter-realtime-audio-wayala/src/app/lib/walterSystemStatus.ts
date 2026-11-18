// Control del descanso y recuperación automática de Walter.
type ErrorType = 'QUOTA' | 'API_ERROR';
type WalterStatus = 'READY' | 'ERROR';

const CHANNEL_NAME = 'walter-channel';
const STORAGE_KEY = 'walter.system.status.v2';
const RETRY_MS = 90_000; 

let currentStatus: WalterStatus = 'READY';
let lastErrorType: ErrorType = 'API_ERROR';
let channel: BroadcastChannel | null = null;
let retryTimer: number | null = null;
let initialized = false;
let waitingForSuccessfulResponse = false;

function saveStatus() {
  if (typeof window === 'undefined') return;

  try {
    if (currentStatus === 'ERROR') {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        status: currentStatus, reason: lastErrorType
      }));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn('[Walter] No se pudo guardar el estado:', error);
  }
}

// Reintentar la conexión solamente cuando Walter está descansando.
function scheduleRecovery() {
  if (typeof window === 'undefined' || currentStatus !== 'ERROR' || retryTimer !== null) return;

  console.log('[Walter] En descanso. Próximo intento en 2 minutos.');

  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (currentStatus !== 'ERROR') return;

    console.log('[Walter] Probando nuevamente la conexión con OpenAI...');

    window.location.reload();
  }, RETRY_MS);
}

// Iniciar sistema de comunicación con el rostro.
export function initWalterSystemStatus() {
  if (typeof window === 'undefined' || initialized) return;
  initialized = true;

  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed?.status === 'ERROR') {
        currentStatus = 'ERROR';
        lastErrorType = parsed?.reason === 'QUOTA' ? 'QUOTA' : 'API_ERROR';
      }
    }
  } catch (error) {
    console.warn('[Walter] No se pudo recuperar el estado:', error);
  }

  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);

    channel.onmessage = ({ data }) => {
      if (data?.type !== 'WALTER_STATUS_REQUEST') return;

      channel?.postMessage(currentStatus === 'ERROR'
        ? { type: 'WALTER_SYSTEM_ERROR', reason: lastErrorType }
        : { type: 'WALTER_SYSTEM_READY' });
    };

    if (currentStatus === 'ERROR') {
      channel.postMessage({ type: 'WALTER_SYSTEM_ERROR', reason: lastErrorType });
    }
  }

  scheduleRecovery();
}

// Cuando OpenAI devuelve un error importante.
export function reportWalterError(error?: unknown) {
  initWalterSystemStatus();

  const detail = (error as any)?.error ?? (error as any)?.data?.error ?? error ?? {};
  const code = String((detail as any)?.code ?? (detail as any)?.type ?? '');
  const message = String((detail as any)?.message ?? (error as any)?.message ?? '');

  const quotaError = /insufficient_quota|quota_exceeded|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|billing_hard_limit|out.of.credit|credit.balance|exceeded.*quota/i.test(`${code} ${message}`);

  // No reemplazar un error de cuota con otro error de desconexión.
  if (quotaError) lastErrorType = 'QUOTA';
  else if (currentStatus !== 'ERROR') lastErrorType = 'API_ERROR';

  currentStatus = 'ERROR';
  waitingForSuccessfulResponse = false;
  saveStatus();

  channel?.postMessage({ type: 'WALTER_SYSTEM_ERROR', reason: lastErrorType });
  console.warn(`[Walter] Modo descanso activado: ${lastErrorType}`);

  scheduleRecovery();
}

// App.tsx llama esta función cuando logra conectarse.
export function reportWalterReady() {
  initWalterSystemStatus();

  // Si se agotaron los créditos, una conexión WebRTC exitosa
  // todavía no garantiza que OpenAI pueda responder.
  if (currentStatus === 'ERROR' && lastErrorType === 'QUOTA') {
    waitingForSuccessfulResponse = true;
    console.log('[Walter] Sesión conectada. Esperando respuesta válida...');
    return;
  }

  setWalterReady();
}

// Se llama cuando OpenAI genera una respuesta válida.
export function reportWalterSuccessfulResponse() {
  if (!waitingForSuccessfulResponse) return;
  setWalterReady();
}

// Restaurar rostro normal y detener reintentos.
function setWalterReady() {
  waitingForSuccessfulResponse = false;
  currentStatus = 'READY';

  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;

  saveStatus();
  channel?.postMessage({ type: 'WALTER_SYSTEM_READY' });

  console.log('[Walter] Conexión recuperada. Volviendo al rostro normal.');
}