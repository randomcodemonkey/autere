#!/usr/bin/env bash

echo "Installing pi extensions"
pi install npm:pi-9router-ext
pi install npm:pi-memory

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
