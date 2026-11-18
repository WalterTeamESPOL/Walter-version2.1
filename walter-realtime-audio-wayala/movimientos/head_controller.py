from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List

import serial

# ======================================================
# CONFIGURACIÓN DEL PUERTO SERIAL
# ======================================================

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PORT = "COM3" if os.name == "nt" else "/dev/ttyUSB0"
PORT = os.getenv("WALTER_HEAD_PORT", DEFAULT_PORT)
BAUDRATE = int(os.getenv("WALTER_HEAD_BAUDRATE", "1000000"))

# ======================================================
# CONFIGURACIÓN DE MOVIMIENTOS
# ======================================================

MODE_CONFIG = {
    "IDLE": {
        "file": BASE_DIR / "quieto.txt",
        "frame_delay": 0.8,
        "loop_delay": 7.0,
    },
    "SPEAKING": {
        "file": BASE_DIR / "test_all.txt",
        "frame_delay": 0.8,
        "loop_delay": 3.0,
    },
}

serial_port: serial.Serial | None = None
running = True
current_mode = "IDLE"
mode_changed = threading.Event()
state_lock = threading.Lock()

def log(message: str) -> None:
    print(message, flush=True)

# ======================================================
# LEER MOVIMIENTOS DESDE TXT
# ======================================================

def load_frames(file_path: Path) -> List[bytes]:
    frames: List[bytes] = []

    with file_path.open("r", encoding="utf-8") as file:
        for line_number, raw_line in enumerate(file, start=1):
            line = raw_line.strip()
            if not line:
                continue

            values = [value.strip() for value in line.split(";")]

            if len(values) != 10:
                raise ValueError(
                    f"{file_path.name}, línea {line_number}: "
                    f"se esperaban 10 valores y llegaron {len(values)}."
                )

            operation_id = int(values[0], 16)
            positions = [int(value) for value in values[1:]]
            frame_values = [operation_id, *positions]

            if any(value < 0 or value > 255 for value in frame_values):
                raise ValueError(
                    f"{file_path.name}, línea {line_number}: valores fuera de 0-255."
                )

            frames.append(bytes(frame_values))

    if not frames:
        raise ValueError(f"{file_path.name} no contiene movimientos válidos.")

    return frames

MOVEMENTS: Dict[str, List[bytes]] = {
    mode: load_frames(config["file"])
    for mode, config in MODE_CONFIG.items()
}

CENTER_FRAME = MOVEMENTS["IDLE"][0]

# ======================================================
# COMUNICACIÓN SERIAL
# ======================================================

def open_serial() -> None:
    global serial_port

    serial_port = serial.Serial(
        port=PORT,
        baudrate=BAUDRATE,
        bytesize=8,
        timeout=1,
        stopbits=serial.STOPBITS_ONE,
    )

    log(f"WALTER_HEAD_READY port={PORT} baudrate={BAUDRATE}")

def send_frame(frame: bytes) -> None:
    if serial_port is None or not serial_port.is_open:
        raise RuntimeError("El puerto serial de la cabeza no está abierto.")

    serial_port.write(frame)
    serial_port.flush()

def center_head() -> None:
    send_frame(CENTER_FRAME)
    log("WALTER_HEAD_CENTERED")

# ======================================================
# CONTROL DE ESTADOS
# ======================================================

def get_mode() -> str:
    with state_lock:
        return current_mode

def set_mode(mode: str) -> None:
    global current_mode

    normalized = mode.strip().upper()

    if normalized not in MODE_CONFIG:
        log(f"WALTER_HEAD_ERROR invalid_mode={normalized}")
        return

    with state_lock:
        if current_mode == normalized:
            return
        current_mode = normalized

    mode_changed.set()
    log(f"WALTER_HEAD_MODE {normalized}")

# ======================================================
# ESPERA INTERRUMPIBLE
# ======================================================

def wait_for_change(seconds: float, expected_mode: str) -> bool:
    changed = mode_changed.wait(timeout=max(0.0, seconds))

    if changed:
        mode_changed.clear()

    return changed or get_mode() != expected_mode

# ======================================================
# EJECUTAR MOVIMIENTOS
# ======================================================

def movement_worker() -> None:
    while running:
        mode = get_mode()
        config = MODE_CONFIG[mode]
        frames = MOVEMENTS[mode]

        log(f"WALTER_HEAD_SEQUENCE {mode}")

        try:
            for frame in frames:
                if not running:
                    return

                # Si cambia de estado, interrumpir la secuencia.
                if get_mode() != mode:
                    break

                send_frame(frame)

                if wait_for_change(config["frame_delay"], mode):
                    break
            else:
                # Esperar antes de repetir el movimiento.
                if wait_for_change(config["loop_delay"], mode):
                    continue

        except Exception as error:
            log(f"WALTER_HEAD_ERROR movement={error}")
            time.sleep(0.5)

# ======================================================
# ESTADO ACTUAL
# ======================================================

def command_status() -> None:
    connected = bool(serial_port and serial_port.is_open)

    log(
        f"WALTER_HEAD_STATUS port={PORT} "
        f"connected={connected} mode={get_mode()}"
    )

# ======================================================
# CERRAR CONTROLADOR
# ======================================================

def shutdown() -> None:
    global running, serial_port

    running = False
    mode_changed.set()

    if serial_port is not None and serial_port.is_open:
        try:
            center_head()
        except Exception:
            pass

        serial_port.close()

    log("WALTER_HEAD_EXIT")

# ======================================================
# INICIO DEL CONTROLADOR
# ======================================================

def main() -> int:
    try:
        open_serial()
    except Exception as error:
        log(f"WALTER_HEAD_FATAL serial={error}")
        return 2

    worker = threading.Thread(
        target=movement_worker,
        name="WalterHeadMovement",
        daemon=True,
    )

    worker.start()
    log("WALTER_HEAD_MODE IDLE")

    try:
        for raw_command in sys.stdin:
            command = raw_command.strip()
            if not command:
                continue

            upper_command = command.upper()

            if upper_command.startswith("MODE "):
                set_mode(upper_command.split(maxsplit=1)[1])
            elif upper_command == "CENTER":
                center_head()
            elif upper_command == "STATUS":
                command_status()
            elif upper_command == "EXIT":
                break
            else:
                log(f"WALTER_HEAD_ERROR unknown_command={upper_command}")

    except KeyboardInterrupt:
        pass
    finally:
        shutdown()
        worker.join(timeout=2.0)

    return 0

if __name__ == "__main__":
    raise SystemExit(main())