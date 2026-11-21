# Grabar médico (web): versión iPhone de MedicoMem

App web instalable de **un solo botón** para que las personas mayores graben sus consultas médicas en un **iPhone**.
Al parar, el audio llega solo al **Telegram de la familia**. Sin servidor, sin cuentas, sin App Store y gratis.

## ✨ Qué hace

- 🎙️ **Botón gigante**: un toque para grabar (pantalla **roja** y pitido) y otro para parar (**✓ GUARDADO** en verde).
- 🔄 **Pantalla del revés** con «▲ HACIA EL MÉDICO ▲», para que el micrófono (borde de abajo) apunte al médico.
- 🔊 **Mejora las voces**: sube la voz lejana, quita golpes y zumbidos y evita que sature la cercana (se puede desactivar).
- 📨 **Envío automático a Telegram** como audio .m4a, con nombre, fecha y duración.
- 💾 **No pierde nada**: guarda un trozo en el móvil cada 5 s. Si la app se cierra, al abrirla de nuevo recupera lo grabado y lo envía.
- 📶 **Sin cobertura**: queda pendiente y se reintenta al abrir la app, al volver la conexión y cada minuto mientras está abierta.
- 📞 **Llamadas**: si entra una llamada, guarda y envía lo grabado y avisa de que hay que tocar GRABAR para seguir.
- 🛟 **Corte a las 3 h** y partes de 30 min en consultas largas.
- ⏱️ **Ignora toques por error**: menos de 10 s no se envía.
- 🔒 **Ajustes escondidos**: mantener pulsado 4 s el texto gris «Configuración familiar».
- 🧹 Lo enviado se borra solo a los 15 días.

Mensaje en Telegram:

```text
🎙️ Cita médica — Mamá
📅 20/11/2026 10:35 · ⏱️ 22 min
⚠️ Se cortó (llamada, Siri o bloqueo de pantalla)   (si pasó)
📶 Enviada con retraso (no había conexión)           (si pasó)
```

## ⚠️ Diferencias con la versión Android

| | |
| :--- | :--- |
| Pantalla apagada | **No graba con la pantalla bloqueada.** La app mantiene la pantalla encendida mientras graba (iOS 16.4 o superior; en apps instaladas, mejor iOS 18.4 o superior). Si en tu iPhone se apaga sola, pon *Ajustes › Pantalla y brillo › Bloqueo automático › Nunca* durante las consultas. |
| Envío en segundo plano | Solo envía con la app abierta. Si al salir de la consulta no había cobertura, se envía la próxima vez que se abra. |
| Llamadas | Tras colgar hay que tocar GRABAR otra vez (la web no puede reanudar sola). |
| Widget, vibración y batería | No disponibles en apps web de iPhone. |

## 🚀 Publicarla (una sola vez)

El micrófono solo funciona en una web **https**. La forma gratuita es GitHub Pages:

1. Crea un repositorio en GitHub (por ejemplo `grabar-medico`) y sube **el contenido de esta carpeta** (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest` y `icons/`).
2. En el repositorio: **Settings › Pages › Build and deployment › Branch: `main` / `(root)` › Save**.
3. En un minuto estará en `https://TU-USUARIO.github.io/grabar-medico/`.

Cualquier hosting estático con https sirve igual (Netlify, Cloudflare Pages…).

## ⚙️ Configuración

**En tu Telegram** (igual que en MedicoMem)

1. 🤖 Habla con **@BotFather**, envía `/newbot` y copia el **token**.
2. 💬 Abre tu bot y pulsa **Iniciar**, o añádelo a un **grupo familiar** y escribe `/start` en el grupo.

**En el iPhone de la persona mayor**

3. 🧭 Abre la dirección en **Safari**. Tiene que ser Safari: desde otro navegador no se puede instalar en todos los iPhone.
4. ⬆️ Toca **Compartir** › **Añadir a pantalla de inicio** › **Añadir**. Abre la app **desde ese icono**.
5. 🔒 **Mantén pulsado 4 s** «Configuración familiar»:
   - ✍️ **Nombre** (`Mamá`, `Papá`…) y pega el **Bot Token**.
   - 🔎 **Buscar chat o grupo** y elige a dónde se envía.
   - ✅ **Probar envío ahora**: te llega un mensaje con el modelo y la versión de iOS.
6. 🎙️ Toca GRABAR y acepta el **micrófono**. Si iOS lo vuelve a preguntar cada vez: *Ajustes › Apps › Safari › Micrófono › Permitir*.
7. 🧪 Haz una prueba de más de 10 s y comprueba que llega. Luego otra de 5 minutos dejando el móvil quieto: si la pantalla no se apaga y el audio llega entero, todo correcto.

## 👂 Para que se oiga bien

- 📱 Móvil **sobre la mesa**, pantalla arriba, con «▲ HACIA EL MÉDICO» apuntando al médico.
- 👜 Nunca en el bolsillo ni en el bolso. Que la funda no tape el micrófono (borde de abajo).
- 🔌 Para consultas largas, mejor con el cargador o con buena batería: la pantalla se queda encendida.

## 🔒 Privacidad

El token y el chat solo se guardan en el iPhone (IndexedDB). Los audios van **directamente** del iPhone a Telegram, sin pasar por ningún otro servidor. La web publicada no contiene ningún dato.

## 🛠️ Probar en el ordenador

```bash
npx http-server . -p 8765 -c-1
```

Abre `http://localhost:8765` (en `localhost` el micrófono funciona sin https).
