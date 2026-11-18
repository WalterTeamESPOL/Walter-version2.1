(() => {
  if (!('BroadcastChannel' in window)) return;

  const channel = new BroadcastChannel('walter-channel');
  const overlay = document.createElement('div');
  overlay.id = 'walterDescansoOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:2147483647;background:#000;align-items:center;justify-content:center;';

  const imagen = document.createElement('img');
  imagen.src = '/face/walter-descanso.svg';
  imagen.alt = 'Walter está descansando';
  imagen.style.cssText = 'width:100%;height:100%;object-fit:contain;';

  imagen.onerror = () => {
    overlay.textContent = 'Walter está descansando...';
    overlay.style.color = '#1de4ff';
    overlay.style.font = 'bold 32px Arial,sans-serif';
  };

  overlay.appendChild(imagen);
  document.body.appendChild(overlay);

  let descansando = false;

  function mostrar(reason = 'API_ERROR') {
    descansando = true;
    overlay.style.display = 'flex';
    console.warn('[Walter] Pantalla de descanso:', reason);
  }

  function ocultar() {
    descansando = false;
    overlay.style.display = 'none';
  }

  channel.onmessage = ({ data }) => {
    if (data?.type === 'WALTER_SYSTEM_ERROR') mostrar(data.reason);
    if (data?.type === 'WALTER_SYSTEM_READY') ocultar();
  };

  // Solicitar el estado actual para detectar errores anteriores a la carga.
  const prueba = new URLSearchParams(location.search).get('walterRestTest') === '1';
  if (!prueba) channel.postMessage({ type: 'WALTER_STATUS_REQUEST' });

  // Modo de prueba visual: F9 alterna la pantalla.
  if (prueba) {
    mostrar('SIMULACION');
    document.addEventListener('keydown', e => {
      if (e.key === 'F9') descansando ? ocultar() : mostrar('SIMULACION');
    });
  }
})();