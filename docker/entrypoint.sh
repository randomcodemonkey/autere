#!/usr/bin/env bash

# Bundled custom extensions (repo extras/) ship in the image at
# /home/autere/pi-ext-extra — link them into the master pi extensions dir.
# pi-dedup is shipped but NOT auto-installed: opt in per user via
# Settings → Extensions (admin can toggle bundled extras).
# pi-9router-ext is installed per user by the backend (always on for 9router
# deployments, hidden from Settings); skip it here on other providers.
piExtensions="$HOME/.pi/agent/extensions"
mkdir -p "$piExtensions"
# AUTERE_PROVIDER is a comma-separated provider list (first = default).
providers="${AUTERE_PROVIDER:-9router}"
has_provider() { case ",${providers//[[:space:]]/}," in *",$1,"*) return 0;; esac; return 1; }
for dir in /home/autere/pi-ext-extra/*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  [ "$name" = "pi-dedup" ] && continue
  if [ "$name" = "pi-9router-ext" ] && ! has_provider 9router; then
    continue
  fi
  ln -sfn "$dir" "$piExtensions/$name"
done

# npm extensions are preinstalled in the image; drop the packages this
# deployment does not use. Idempotent: safe on every entrypoint rerun.
piSettings="$HOME/.pi/agent/settings.json"
jq --arg p "$providers" '
  def has($name): ($p | gsub("\\s"; "") | split(",") | index($name)) != null;
  def keep($src):
    $src == "npm:pi-memory"
    or ($src == "npm:pi-web-search" and (has("9router") | not))
    or ($src == "npm:copilot-credit-usage" and has("github-copilot"));
  .packages |= [ .[]
    | if (type == "string") then {source: .} else . end
    | select(.source | keep(.)) ]' "$piSettings" > "$piSettings.tmp" && mv "$piSettings.tmp" "$piSettings"

echo "AUTERE_PROVIDER=${providers} — pi extensions configured"

echo "Initializing admin pi-env"
mkdir -p ~/.autere/pi-envs/admin
mkdir -p ~/.pi/agent/skills/autere && cp /home/autere/SKILL.md ~/.pi/agent/skills/autere
mkdir -p ~/.autere/pi-envs/admin/skills/autere && cp /home/autere/SKILL.md ~/.autere/pi-envs/admin/skills/autere/SKILL.md
rm /home/autere/SKILL.md

if [ ! -f ~/.autere/pi-envs/admin/personas.json ]; then
  echo "Seeding Autere persona"
  PERSONA_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
PERSONA_PROMPT='You are a senior full-stack engineer with deep expertise in React, Node.js, JavaScript, TypeScript, and end-to-end web development. You know the pi coding agent and understand how LLM model routing works; draw on that knowledge whenever it is relevant to the task.\n\nDo exactly what is needed - no more, no less. Complete the task fully, but never over-engineer or add unrequested features. Write code that is readable and reusable: clear names, sensible structure, logic another developer can pick up and build on. Keep comments short and to the point; explain why, not what.\n\nBe direct and practical in tone. Lead with the solution, not the preamble. Skip pleasantries and filler. If something is ambiguous, make a reasonable call, state it briefly, and proceed - ask a question only when the wrong guess would be costly.'
printf '[{\n  "id": "%s",\n  "name": "Autere",\n  "description": "Specialist for autere development",\n  "prompt": "%s"\n}]\n' "$PERSONA_ID" "$PERSONA_PROMPT" > ~/.autere/pi-envs/admin/personas.json
else
  echo "Persona file exists, not seeding"
fi

echo "Starting supervisord"
supervisord -n -c /etc/supervisor/conf.d/supervisord.conf -l /home/autere/supervisord.log -j /home/autere/supervisord.pid
