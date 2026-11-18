import { useCallback, useRef, useState } from 'react';
import { RealtimeSession, RealtimeAgent, OpenAIRealtimeWebRTC } from '@openai/agents/realtime';
import { useEvent } from '../contexts/EventContext';
import { useHandleSessionHistory } from './useHandleSessionHistory';
import { SessionStatus } from '../types';
import { reportWalterError, reportWalterSuccessfulResponse } from '../lib/walterSystemStatus';

export interface RealtimeSessionCallbacks {
  onConnectionChange?: (status: SessionStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
  onAudioBufferStarted?: () => void;
  onAudioBufferStopped?: () => void;
}

export interface ConnectOptions {
  getEphemeralKey: () => Promise<string>;
  initialAgents: RealtimeAgent[];
  audioElement?: HTMLAudioElement;
  extraContext?: Record<string, any>;
  outputGuardrails?: any[];
}

type WalterHeadState = 'IDLE' | 'SPEAKING';
type WalterElectronWindow = Window & {
  walterElectron?: { setHeadState: (state: WalterHeadState) => void };
};

function sendWalterMouthEvent(type: 'WALTER_AUDIO_START' | 'WALTER_AUDIO_END') {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
  const channel = new BroadcastChannel('walter-channel');
  channel.postMessage({ type });
  channel.close();
}

function sendWalterHeadState(state: WalterHeadState) {
  if (typeof window === 'undefined') return;
  (window as WalterElectronWindow).walterElectron?.setHeadState(state);
}

// Solo los errores bloqueantes activan el descanso.
function isBlockingRealtimeError(value: unknown): boolean {
  const parts: string[] = [];
  const visited = new Set<object>();

  const inspect = (item: unknown, depth = 0): void => {
    if (depth > 4 || item == null) return;

    if (typeof item === 'string' || typeof item === 'number') {
      parts.push(String(item));
      return;
    }

    if (typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);

    const obj = item as Record<string, unknown>;
    for (const field of ['code', 'type', 'message', 'status', 'error', 'cause', 'data', 'status_details', 'details']) {
      if (field in obj) inspect(obj[field], depth + 1);
    }
  };

  inspect(value);
  const text = parts.join(' ').toLowerCase();

  return /\b(insufficient_quota|quota_exceeded|credit_balance_exhausted|billing_hard_limit|billing_hard_limit_reached|organization_spend_limit_exceeded|project_spend_limit_exceeded|organization_usage_limit_exceeded|invalid_api_key|authentication_error|invalid_authentication|account_deactivated|billing_not_active|401|403)\b|out.of.credit|credit.balance.exhausted/i.test(text);
}

export function useRealtimeSession(callbacks: RealtimeSessionCallbacks = {}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const isWalterSpeakingRef = useRef(false);
  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');

  const { logClientEvent, logServerEvent } = useEvent();
  const historyHandlers = useHandleSessionHistory().current;

  const updateStatus = useCallback((s: SessionStatus) => {
    setStatus(s);
    callbacks.onConnectionChange?.(s);
    logClientEvent({}, s);
  }, [callbacks, logClientEvent]);

  // Detener conversación únicamente ante errores bloqueantes.
  const handleBlockingError = useCallback((error: unknown) => {
    if (!isBlockingRealtimeError(error)) {
      console.warn('[Walter] Error recuperable: se conserva el rostro normal.', error);
      return;
    }

    console.error('[Walter] Error bloqueante: activando descanso.');
    reportWalterError(error);

    isWalterSpeakingRef.current = false;
    sendWalterMouthEvent('WALTER_AUDIO_END');
    sendWalterHeadState('IDLE');

    // Cerrar sesión actual para evitar conexiones duplicadas.
    const activeSession = sessionRef.current;
    sessionRef.current = null;

    if (activeSession) {
      try {
        activeSession.close();
      } catch (closeError) {
        console.warn('[Walter] Error al cerrar sesión:', closeError);
      }
      updateStatus('DISCONNECTED');
    }
  }, [updateStatus]);

  const handleTransportEvent = useCallback((event: any) => {
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed': {
        historyHandlers.handleTranscriptionCompleted(event);
        break;
      }

      case 'response.audio_transcript.done': {
        historyHandlers.handleTranscriptionCompleted(event);
        break;
      }

      case 'response.audio_transcript.delta': {
        historyHandlers.handleTranscriptionDelta(event);
        break;
      }

      case 'error': {
        handleBlockingError(event?.error ?? event);
        logServerEvent(event);
        break;
      }

      case 'response.done': {
        // Una respuesta completada confirma la recuperación.
        if (event?.response?.status === 'completed') {
          reportWalterSuccessfulResponse();
        }

        if (event?.response?.status === 'failed') {
          handleBlockingError(event.response.status_details?.error ?? { code: 'response_failed' });
        }

        logServerEvent(event);
        break;
      }

      case 'output_audio_buffer.started': {
        // Si Walter puede generar audio nuevamente, despertar.
        reportWalterSuccessfulResponse();

        isWalterSpeakingRef.current = true;
        console.log('🎤 Walter empezó a hablar');

        sendWalterMouthEvent('WALTER_AUDIO_START');
        sendWalterHeadState('SPEAKING');

        callbacks.onAudioBufferStarted?.();
        logServerEvent(event);
        break;
      }

      case 'output_audio_buffer.stopped': {
        isWalterSpeakingRef.current = false;
        console.log('🔇 Walter terminó de hablar');

        sendWalterMouthEvent('WALTER_AUDIO_END');
        sendWalterHeadState('IDLE');

        callbacks.onAudioBufferStopped?.();
        logServerEvent(event);
        break;
      }

      default: {
        logServerEvent(event);
        break;
      }
    }
  }, [callbacks, historyHandlers, logServerEvent, handleBlockingError]);

  const handleAgentHandoff = useCallback((item: any) => {
    const history = item.context.history;
    const lastMessage = history[history.length - 1];
    const agentName = lastMessage.name.split('transfer_to_')[1];
    callbacks.onAgentHandoff?.(agentName);
  }, [callbacks]);

  const connect = useCallback(async ({
    getEphemeralKey, initialAgents, audioElement, extraContext, outputGuardrails
  }: ConnectOptions) => {
    if (sessionRef.current) return;
    updateStatus('CONNECTING');

    let session: RealtimeSession | null = null;

    try {
      const ek = await getEphemeralKey();
      const rootAgent = initialAgents[0];

      session = new RealtimeSession(rootAgent, {
        transport: new OpenAIRealtimeWebRTC({ audioElement }),
        model: 'gpt-realtime-2',
        config: {
          audio: {
            input: {
              turnDetection: {
                type: 'server_vad',
                threshold: 0.8,
                prefixPaddingMs: 300,
                silenceDurationMs: 800,
                createResponse: true,
                interruptResponse: false,
              },
            },
          },
        },
        outputGuardrails: outputGuardrails ?? [],
        context: extraContext ?? {},
      });

      session.on('error', (...args: any[]) => {
        handleBlockingError(args[0]);
        logServerEvent({ type: 'error', message: args[0] });
      });

      session.on('agent_handoff', handleAgentHandoff);
      session.on('agent_tool_start', historyHandlers.handleAgentToolStart);
      session.on('agent_tool_end', historyHandlers.handleAgentToolEnd);
      session.on('history_updated', historyHandlers.handleHistoryUpdated);
      session.on('history_added', historyHandlers.handleHistoryAdded);
      session.on('transport_event', handleTransportEvent);

      sessionRef.current = session;
      await session.connect({ apiKey: ek });

      if (sessionRef.current !== session) {
        throw new Error('La sesión se cerró durante la conexión.');
      }

      updateStatus('CONNECTED');
    } catch (error) {
      sessionRef.current = null;
      session?.close();
      updateStatus('DISCONNECTED');
      throw error;
    }
  }, [updateStatus, logServerEvent, handleAgentHandoff, handleTransportEvent, historyHandlers, handleBlockingError]);

  const disconnect = useCallback(() => {
    isWalterSpeakingRef.current = false;
    sendWalterMouthEvent('WALTER_AUDIO_END');
    sendWalterHeadState('IDLE');

    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus('DISCONNECTED');
  }, [updateStatus]);

  const assertConnected = () => {
    if (!sessionRef.current) throw new Error('RealtimeSession not connected');
  };

  const interrupt = useCallback(() => {
    isWalterSpeakingRef.current = false;
    sendWalterMouthEvent('WALTER_AUDIO_END');
    sendWalterHeadState('IDLE');
    sessionRef.current?.interrupt();
  }, []);

  const sendUserText = useCallback((text: string) => {
    assertConnected();
    sessionRef.current!.sendMessage(text);
  }, []);

  const sendEvent = useCallback((ev: any) => {
    sessionRef.current?.transport.sendEvent(ev);
  }, []);

  const mute = useCallback((m: boolean) => {
    sessionRef.current?.mute(m);
  }, []);

  const pushToTalkStart = useCallback(() => {
    if (!sessionRef.current) return;
    sessionRef.current.transport.sendEvent({
      type: 'input_audio_buffer.clear',
    } as any);
  }, []);

  const pushToTalkStop = useCallback(() => {
    if (!sessionRef.current) return;

    if (isWalterSpeakingRef.current) {
      console.log('Walter sigue hablando. No se crea una nueva respuesta todavía.');
      return;
    }

    sessionRef.current.transport.sendEvent({
      type: 'input_audio_buffer.commit',
    } as any);

    sessionRef.current.transport.sendEvent({
      type: 'response.create',
    } as any);
  }, []);

  return {
    status, connect, disconnect, sendUserText, sendEvent,
    mute, pushToTalkStart, pushToTalkStop, interrupt
  } as const;
}