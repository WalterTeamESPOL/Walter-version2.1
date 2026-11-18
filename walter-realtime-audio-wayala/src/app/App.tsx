"use client";

import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { v4 as uuidv4 } from "uuid";
import Image from "next/image";
import type { RealtimeAgent } from "@openai/agents/realtime";

import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";
import { SessionStatus } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRealtimeSession } from "./hooks/useRealtimeSession";
import { initWalterSystemStatus, reportWalterError, reportWalterReady } from "./lib/walterSystemStatus";
import { createModerationGuardrail } from "@/app/agentConfigs/guardrails";

import { allAgentSets, defaultAgentSetKey } from "@/app/agentConfigs";
import { customerServiceRetailScenario, customerServiceRetailCompanyName } from "@/app/agentConfigs/customerServiceRetail";
import { chatSupervisorScenario, chatSupervisorCompanyName } from "@/app/agentConfigs/chatSupervisor";
import { simpleHandoffScenario } from "@/app/agentConfigs/simpleHandoff";
import { walterScenario } from "@/app/agentConfigs/walter";
import { walterScenario1 } from "@/app/agentConfigs/walterfiec";
import { walterCtiScenario } from "@/app/agentConfigs/waltercti";
import { walterScenarioParesNones } from "@/app/agentConfigs/walter_pares_nones";

import useAudioDownload from "./hooks/useAudioDownload";
import { useHandleSessionHistory } from "./hooks/useHandleSessionHistory";

const sdkScenarioMap: Record<string, RealtimeAgent[]> = {
  simpleHandoff: simpleHandoffScenario,
  customerServiceRetail: customerServiceRetailScenario,
  chatSupervisor: chatSupervisorScenario,
  walter: walterScenario,
  walterfiec: walterScenario1,
  waltercti: walterCtiScenario,
  walter_pares_nones: walterScenarioParesNones,
};

function App() {
  const searchParams = useSearchParams()!;
  const urlCodec = searchParams.get("codec") || "opus";

  const { addTranscriptMessage, addTranscriptBreadcrumb } = useTranscript();
  const { logClientEvent, logServerEvent } = useEvent();

  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<RealtimeAgent[] | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("DISCONNECTED");

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const handoffTriggeredRef = useRef(false);

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState(true);
  const [userText, setUserText] = useState("");
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState(false);

  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("audioPlaybackEnabled");
    return stored ? stored === "true" : true;
  });

  const sdkAudioElement = React.useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const el = document.createElement("audio");
    el.autoplay = true;
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  }, []);

  useEffect(() => {
    if (sdkAudioElement && !audioElementRef.current) {
      audioElementRef.current = sdkAudioElement;
    }
  }, [sdkAudioElement]);

  const { connect, disconnect, sendUserText, sendEvent, interrupt, mute } = useRealtimeSession({
    onConnectionChange: (s) => setSessionStatus(s as SessionStatus),
    onAgentHandoff: (agentName: string) => {
      handoffTriggeredRef.current = true;
      setSelectedAgentName(agentName);
    },
  });

  // NUEVO: iniciar el sistema de comunicación del estado de Walter.
  useEffect(() => {
    initWalterSystemStatus();
  }, []);

  const { startRecording, stopRecording, downloadRecording } = useAudioDownload();
  useHandleSessionHistory();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix);
    } catch (err) {
      console.error("Failed to send via SDK", err);
    }
  };

  // Seleccionar agente inicial.
  useEffect(() => {
    let finalAgentConfig = searchParams.get("agentConfig");

    if (!finalAgentConfig || !allAgentSets[finalAgentConfig]) {
      finalAgentConfig = defaultAgentSetKey;
      const url = new URL(window.location.toString());
      url.searchParams.set("agentConfig", finalAgentConfig);
      window.location.replace(url.toString());
      return;
    }

    const agents = allAgentSets[finalAgentConfig];
    const agentKeyToUse = agents[0]?.name || "";

    setSelectedAgentName(agentKeyToUse);
    setSelectedAgentConfigSet(agents);
  }, [searchParams]);

  // Conexión automática de Walter.
  useEffect(() => {
    if (selectedAgentName && sessionStatus === "DISCONNECTED") {
      connectToRealtime();
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (sessionStatus !== "CONNECTED" || !selectedAgentConfigSet || !selectedAgentName) return;

    const currentAgent = selectedAgentConfigSet.find(a => a.name === selectedAgentName);
    addTranscriptBreadcrumb(`Agent: ${selectedAgentName}`, currentAgent);
    updateSession(!handoffTriggeredRef.current);
    handoffTriggeredRef.current = false;
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") updateSession();
  }, [isPTTActive]);

  // ======================================================
  // NUEVO: DETECTAR ERRORES EN LA API DE OPENAI
  // ======================================================

  const fetchEphemeralKey = async (): Promise<string | null> => {
    logClientEvent({ url: "/api/session" }, "fetch_session_token_request");

    const response = await fetch("/api/session");
    let data: any;

    try {
      data = await response.json();
    } catch {
      console.error("[Walter] /api/session no devolvió JSON. HTTP:", response.status);
      reportWalterError({ code: "invalid_session_response" });
      setSessionStatus("DISCONNECTED");
      return null;
    }

    if (!response.ok) {
      console.error(
        "[Walter] Error /api/session:",
        response.status,
        data?.error?.code ?? data?.error?.message ?? "desconocido"
      );

      // Activa el modo descanso.
      reportWalterError(data);
      setSessionStatus("DISCONNECTED");
      return null;
    }

    if (typeof data?.value !== "string" || !data.value) {
      console.error("[Walter] La respuesta no contiene clave temporal.");
      reportWalterError({ code: "missing_ephemeral_key" });
      setSessionStatus("DISCONNECTED");
      return null;
    }

    // No imprimir ni exponer la clave temporal.
    return data.value;
  };

  // ======================================================
  // CONECTAR CON OPENAI REALTIME
  // ======================================================

  const connectToRealtime = async () => {
    const agentSetKey = searchParams.get("agentConfig") || "default";
    if (!sdkScenarioMap[agentSetKey]) return;
    if (sessionStatus !== "DISCONNECTED") return;

    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) return;

      const reorderedAgents = [...sdkScenarioMap[agentSetKey]];
      const idx = reorderedAgents.findIndex(a => a.name === selectedAgentName);

      if (idx > 0) {
        const [agent] = reorderedAgents.splice(idx, 1);
        reorderedAgents.unshift(agent);
      }

      const companyName = agentSetKey === "customerServiceRetail"
        ? customerServiceRetailCompanyName
        : chatSupervisorCompanyName;

      const guardrail = createModerationGuardrail(companyName);

      await connect({
        getEphemeralKey: async () => EPHEMERAL_KEY,
        initialAgents: reorderedAgents,
        audioElement: sdkAudioElement,
        outputGuardrails: [guardrail],
        extraContext: { addTranscriptBreadcrumb },
      });

      // Conexión exitosa.
      reportWalterReady();
    } catch (err) {
      console.error("Error connecting via SDK:", err);

      // NUEVO: informar error a la pantalla.
      reportWalterError(err);
      setSessionStatus("DISCONNECTED");
    }
  };

  const disconnectFromRealtime = () => {
    disconnect();
    setSessionStatus("DISCONNECTED");
    setIsPTTUserSpeaking(false);
  };

  const sendSimulatedUserMessage = (text: string) => {
    const id = uuidv4().slice(0, 32);
    addTranscriptMessage(id, "user", text, true);

    sendClientEvent({
      type: "conversation.item.create",
      item: {
        id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });

    sendClientEvent({ type: "response.create" }, "(simulated user text message)");
  };

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    const turnDetection = isPTTActive
      ? null
      : {
          type: "server_vad",
          threshold: 0.9,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        };

    sendEvent({
      type: "session.update",
      session: { turn_detection: turnDetection },
    });

    if (shouldTriggerResponse) sendSimulatedUserMessage("hi");
  };

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    interrupt();

    try {
      sendUserText(userText.trim());
    } catch (err) {
      console.error("Failed to send via SDK", err);
    }

    setUserText("");
  };

  const handleTalkButtonDown = () => {
    if (sessionStatus !== "CONNECTED") return;
    interrupt();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: "input_audio_buffer.clear" }, "clear PTT buffer");
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== "CONNECTED" || !isPTTUserSpeaking) return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: "input_audio_buffer.commit" }, "commit PTT");
    sendClientEvent({ type: "response.create" }, "trigger response PTT");
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      disconnectFromRealtime();
      setSessionStatus("DISCONNECTED");
    } else {
      connectToRealtime();
    }
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("agentConfig", e.target.value);
    window.location.replace(url.toString());
  };

  const handleSelectedAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    disconnectFromRealtime();
    setSelectedAgentName(e.target.value);
  };

  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  // ======================================================
  // PREFERENCIAS DE INTERFAZ
  // ======================================================

  useEffect(() => {
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) setIsPTTActive(storedPushToTalkUI === "true");

    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) setIsEventsPaneExpanded(storedLogsExpanded === "true");

    const storedAudioPlaybackEnabled = localStorage.getItem("audioPlaybackEnabled");
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem("audioPlaybackEnabled", isAudioPlaybackEnabled.toString());
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (audioElementRef.current) {
      if (isAudioPlaybackEnabled) {
        audioElementRef.current.muted = false;
        audioElementRef.current.play().catch(err => {
          console.warn("Autoplay may be blocked by browser:", err);
        });
      } else {
        audioElementRef.current.muted = true;
        audioElementRef.current.pause();
      }
    }

    try {
      mute(!isAudioPlaybackEnabled);
    } catch (err) {
      console.warn("Failed to toggle SDK mute", err);
    }
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus !== "CONNECTED") return;

    try {
      mute(!isAudioPlaybackEnabled);
    } catch (err) {
      console.warn("mute sync after connect failed", err);
    }
  }, [sessionStatus, isAudioPlaybackEnabled]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED" && audioElementRef.current?.srcObject) {
      const remoteStream = audioElementRef.current.srcObject as MediaStream;
      startRecording(remoteStream);
    }

    return () => stopRecording();
  }, [sessionStatus]);

  const agentSetKey = searchParams.get("agentConfig") || "default";

  // ======================================================
  // INTERFAZ ORIGINAL DE WALTER
  // ======================================================

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <Image
            src="/openai-logomark.svg"
            alt="OpenAI Logo"
            width={20}
            height={20}
            className="mr-2"
          />
          <div>
            Realtime API <span className="text-gray-500">Agents</span>
          </div>
        </div>

        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            Scenario
          </label>

          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map(agentKey => (
                <option key={agentKey} value={agentKey}>{agentKey}</option>
              ))}
            </select>

            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"/>
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                Agent
              </label>

              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-gray-300 rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map(agent => (
                    <option key={agent.name} value={agent.name}>{agent.name}</option>
                  ))}
                </select>

                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"/>
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <Transcript
          userText={userText}
          setUserText={setUserText}
          onSendMessage={handleSendTextMessage}
          downloadRecording={downloadRecording}
          canSend={sessionStatus === "CONNECTED"}
        />
        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;