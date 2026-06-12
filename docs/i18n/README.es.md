# Memorize — memoria compartida para agentes de código IA

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](../../LICENSE)

[English](../../README.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | **Español**

<p align="center">
  <img src="../../.github/assets/social-preview.png" alt="memorize — shared memory for AI coding agents" width="720">
</p>


> Un cerebro de proyecto persistente compartido entre tú, Claude Code y
> Codex — local-first, event-sourced, inspirado en cómo funciona
> realmente la memoria biológica.

Tu agente lo olvida todo cuando termina la sesión. Memorize lo observa
mientras trabaja, destila lo importante en memorias a largo plazo y las
reinyecta al comienzo de cada sesión futura — para **todos** los agentes
del proyecto, entre máquinas, sin servidor y sin API key.

## Por qué

- **La sesión de Claude termina y el contexto muere con ella.** En la
  siguiente sesión vuelves a explicar qué hacías, qué decidiste y dónde
  te quedaste.
- **Cambiar de Claude a Codex significa empezar de cero.** Cada agente
  tiene su propio silo de memoria; ninguno ve las notas del otro.
- **Dos máquinas, dos medios cerebros.** El contexto de tu escritorio no
  te sigue al portátil.

## Cómo funciona

1. **Captura** — mientras el agente trabaja, los hooks registran
   observaciones baratas filtradas por reglas (ediciones de archivos,
   decisiones, transiciones de tareas). Sin LLM, sin latencia.
2. **Consolidación** — en los límites de sesión, un proceso en segundo
   plano destila las observaciones en memorias a largo plazo
   (decisiones, razones, progreso) con puntuación de relevancia. El
   extractor funciona a través de tu login existente de
   `claude` / `codex` — sin API key — o cualquier endpoint compatible
   con OpenAI, con un fallback basado en reglas.
3. **Recuperación** — al comenzar la siguiente sesión, las memorias
   compiten por un presupuesto de contexto según relevancia × frescura
   (semivida de 14 días, reforzada al reutilizarse) × afinidad con la
   tarea actual. El olvido ocurre solo al recuperar; nada se borra.
4. **Compartir** — las sesiones paralelas ven el trabajo de las demás en
   vivo (incluyendo avisos de colisión de archivos); el mismo log de
   eventos se sincroniza entre máquinas y converge de forma
   determinista. Las contradicciones entre memorias se detectan y
   resuelven — gana la más nueva, la antigua sigue siendo recuperable.

La historia completa — el diseño de memoria CLS de dos capas, la
consolidación idempotente por watermark, el olvido en tiempo de
recuperación, el programa de lifecycle-evidence que evoluciona el
esquema con datos de dogfooding — está en
**[ARCHITECTURE.md](../ARCHITECTURE.md)** (en inglés).

### Lo que tu agente ve al iniciar sesión

```text
# Memorize context

Ground rule: memorize is the single source of truth for project state …

Project: Realtime whiteboard MVP
Task: Fix cursor jitter on remote drag
Latest handoff: from codex — "Repro narrowed to the throttle in
  useRemoteCursor; failing test added in cursor-sync.test.ts"
Consolidated memories:
- [decision/s9] WebSocket transport chosen over WebRTC for v1 — simpler
  infra, revisit only if >200ms RTT becomes common
- [rationale/s7] Cursor positions are sent unthrottled on purpose; the
  jitter came from double-throttling, not bandwidth
- [progress/s5] LAN sync verified; jitter reproduces only above 80ms RTT
Recent work signals (prior session tail):
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

Sin volver a explicar nada. El siguiente agente — cualquier agente,
cualquier máquina — continúa exactamente desde aquí.

## Instalación

Hay dos caminos. **La mayoría debería usar el primero** — memorize está
hecho para que tu asistente de IA lo instale por proyecto.

### Recomendado — deja que tu IA lo configure

Envía a tu sesión de Claude Code o Codex un solo prompt:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

El asistente añade el paquete, vincula el directorio, instala el hook
correcto, ofrece absorber tu contexto existente (su propia memoria de
sesión, tus documentos de decisiones) en memorize y verifica la
instalación. Después usa `claude` / `codex` como siempre — el contexto
se inyecta automáticamente al iniciar la sesión.

Verifica en cualquier momento con:

```sh
npx @shakystar/memorize doctor
```

(Con npx usa siempre el nombre con scope — el paquete `memorize` sin
scope en npm no tiene relación con este proyecto.)

### Manual — ponlo tú mismo en el PATH

<details>
<summary>Instalación en una línea (binario global + <code>memorize setup</code>)</summary>

```sh
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.ps1 | iex
```

Esto instala el binario global y ejecuta `memorize setup`, que detecta
Claude Code y Codex. La integración de Codex se conecta globalmente al
momento; los hooks de Claude son por proyecto, así que `setup` te indica
ejecutar `memorize install claude` dentro de cada proyecto donde quieras
memorize.

Requiere Node.js >= 22. El instalador lo comprueba y te dice dónde
conseguirlo si falta.

</details>

## Directorio de trabajo

- Ejecuta los comandos de memorize desde cualquier lugar dentro de tu
  proyecto — sube desde el directorio actual hasta el proyecto vinculado
  más cercano (igual que git).
- `.memorize/` dentro de tu proyecto guarda estado de runtime por
  proyecto. **Añade `.memorize/` a tu `.gitignore`**; `doctor` avisa si
  falta.
- El log de eventos persistente vive en `~/.memorize/` por defecto
  (modificable con `MEMORIZE_ROOT`).

## Comandos del día a día

Rara vez los necesitas — tu IA conduce la mayoría de interacciones. Los
que podrías usar como humano:

```sh
memorize doctor            # diagnostica proyecto + integraciones
memorize update            # actualiza la CLI + refresca las integraciones en toda la máquina
memorize session activity  # ¿qué hacen mis otras sesiones?
memorize consolidate       # ejecuta una consolidación de memoria ahora
memorize search <query>    # busca en la memoria del proyecto
memorize project show      # resumen del proyecto vinculado (JSON)
memorize version           # versión del binario que se ejecutó
```

Las tareas y traspasos (`memorize task …`) son una capa opcional de
coordinación explícita entre agentes — la memoria ambiental no las
necesita, y una lista de tareas vacía es normal.

Ejecuta `memorize` a secas para ver el resumen de uso. El resto de
comandos (setup, install, memory import, hook, projection rebuild, sync,
etc.) están documentados en [AGENT_GUIDE.md](../../AGENT_GUIDE.md) — el
archivo que tu IA lee cuando necesita detalle.

## Solución de problemas

- La instalación falló a medias — pega el error completo en tu sesión de
  Claude/Codex junto con el enlace a
  [AI_SETUP.md](../../guides/AI_SETUP.md); su sección "Recovering a
  failed install" guía al agente por las causas habituales (versión de
  Node, permisos globales de npm, PATH, solapamiento en WSL). ¿Sin
  agente a mano? Abre un issue con la plantilla **Install failure**.

- La sesión de Claude no muestra contexto de memorize — ejecuta
  `memorize doctor` y sigue el campo `fix:` de cada check fallido.
  Normalmente basta con repetir `memorize install claude`.
- Codex no registra nada aunque la instalación tuvo éxito — codex omite
  silenciosamente los hooks escritos por herramientas externas hasta que
  los apruebas una vez en una sesión interactiva; `doctor` lo detecta y
  te lo dice.
- La lista de tareas está vacía aunque creaste tareas — ejecuta
  `memorize project show` para confirmar que el id del proyecto
  coincide; puede que estés dentro de otro proyecto vinculado.
- Eliminar memorize por completo de un proyecto:
  - `memorize uninstall claude` y/o `memorize uninstall codex` —
    elimina los hooks de memorize y el bloque ground-rule preservando el
    resto de tu configuración. Idempotente. La memoria capturada queda
    intacta.
  - borra `.memorize/` en tu proyecto para eliminar el estado de
    runtime por proyecto
  - opcionalmente `rm -rf ~/.memorize` para borrar el log de eventos de
    todos los proyectos — el único paso que elimina memoria capturada.

## Para asistentes de IA

Si eres un asistente de código IA y el usuario te pidió configurar
memorize, sigue [guides/AI_SETUP.md](../../guides/AI_SETUP.md) — los pasos
idempotentes, el flujo de absorción de contexto preexistente y la regla
de oro (memorize es la única fuente de verdad; no dupliques su estado en
tu propio sistema de memoria). Para el comportamiento completo de los
comandos, ve [AGENT_GUIDE.md](../../AGENT_GUIDE.md).

## Estado

Memorize está en la línea `2.x` (AGPL-3.0-or-later desde 2.0.0). El
compromiso de compatibilidad cubre:

- El layout del log de eventos en disco y la forma del directorio
  `.memorize/` por proyecto.
- La superficie CLI del día a día listada arriba.
- Los contratos de hooks que escriben `install claude` e
  `install codex`.

Dentro de una línea mayor no los romperemos. El log de eventos está
versionado y las proyecciones son regenerables, así que actualizar
dentro de una versión mayor no requiere migración manual de datos.

**Experimental** (puede cambiar en una versión menor):

- `memorize project sync` — el transporte por archivos funciona y está
  probado en ida y vuelta; el cliente de relay HTTP está incluido pero
  necesita un servidor de relay aparte (en camino).
- Los campos de lifecycle-evidence de solo observación y la forma de
  `consolidate --report` — instrumentación que puede cambiar cuando se
  decida la taxonomía.

Historial de versiones en [CHANGELOG.md](../../CHANGELOG.md).

## Comunidad

Issues y discusiones abiertas a todo el mundo — reportes de bugs,
debates de diseño y preguntas de "cómo se hace…" son bienvenidos:

- **[Issues](https://github.com/shakystar/memorize/issues)** para bugs y
  peticiones concretas.
- **[Discussions](https://github.com/shakystar/memorize/discussions)**
  para direcciones de diseño e ideas abiertas (los debates sobre la
  taxonomía de memoria viven ahí).

Ve [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) para el flujo de desarrollo.

## Licencia

AGPL-3.0-or-later. Ver [LICENSE](../../LICENSE).
