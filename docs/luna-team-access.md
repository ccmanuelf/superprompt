# Luna Team Access / Acceso al Equipo Luna

Luna's web UI is served over HTTPS on the office LAN at **https://luna.novalink.local**
(voice chat, dashboards, `/learn` tutoring). Because there is no public domain, the
TLS certificate is signed by an internal CA (mkcert). Each device needs two one-time
steps: **(1) trust the CA certificate, (2) map the hostname**.

La interfaz web de Luna se sirve por HTTPS en la LAN de la oficina en
**https://luna.novalink.local** (chat de voz, tableros, tutoría `/learn`). Como no hay
dominio público, el certificado TLS está firmado por una CA interna (mkcert). Cada
dispositivo necesita dos pasos únicos: **(1) confiar en el certificado de la CA,
(2) mapear el nombre del host**.

- CA certificate / Certificado de la CA: [`docs/luna-rootCA.pem`](./luna-rootCA.pem)
  (public part only — the private key never leaves the server / solo la parte
  pública — la llave privada nunca sale del servidor)
- Server IP / IP del servidor: `192.168.2.244`

---

## 1. Trust the CA / Confiar en la CA

### macOS
1. Download / Descarga `luna-rootCA.pem`.
2. Double-click it — Keychain Access opens. / Haz doble clic — se abre Acceso a Llaveros.
3. Find "mkcert development CA" in the **System** keychain, open it, expand **Trust**,
   set **When using this certificate** to **Always Trust**. /
   Busca "mkcert development CA" en el llavero **Sistema**, ábrelo, expande **Confiar**,
   y en **Al utilizar este certificado** elige **Confiar siempre**.

### Windows
1. Download / Descarga `luna-rootCA.pem` and rename to / y renómbralo a `luna-rootCA.crt`.
2. Double-click → **Install Certificate** → **Local Machine** →
   **Place all certificates in the following store** → **Trusted Root Certification
   Authorities**. / Doble clic → **Instalar certificado** → **Equipo local** →
   **Colocar todos los certificados en el siguiente almacén** → **Entidades de
   certificación raíz de confianza**.

### iOS / iPadOS
1. Send yourself the file (AirDrop or email) and open it — iOS says "Profile
   Downloaded". / Envíate el archivo (AirDrop o correo) y ábrelo — iOS dirá
   "Perfil descargado".
2. Settings → General → VPN & Device Management → install the profile. /
   Ajustes → General → VPN y gestión de dispositivos → instala el perfil.
3. **Required extra step / Paso extra obligatorio:** Settings → General → About →
   Certificate Trust Settings → enable full trust for "mkcert development CA". /
   Ajustes → General → Información → Configuración de confianza de certificados →
   activa la confianza total para "mkcert development CA".

### Android
1. Download / Descarga `luna-rootCA.pem`.
2. Settings → Security & privacy → More security settings → Install from device
   storage → **CA certificate** → accept the warning → select the file. /
   Ajustes → Seguridad y privacidad → Más ajustes de seguridad → Instalar desde
   almacenamiento → **Certificado CA** → acepta la advertencia → elige el archivo.
   (Menu names vary by vendor / los menús varían según el fabricante.)

### Firefox (any OS / cualquier SO)
Firefox uses its own trust store: Settings → Privacy & Security → Certificates →
View Certificates → Authorities → Import → select `luna-rootCA.pem`, check
"Trust this CA to identify websites". / Firefox usa su propio almacén: Ajustes →
Privacidad y seguridad → Certificados → Ver certificados → Autoridades → Importar →
elige `luna-rootCA.pem` y marca "Confiar en esta CA para identificar sitios web".

---

## 2. Map the hostname / Mapear el nombre del host

There is no internal DNS, so each device must resolve `luna.novalink.local` itself. /
No hay DNS interno, así que cada dispositivo debe resolver `luna.novalink.local`.

### macOS / Linux
```bash
echo "192.168.2.244 luna.novalink.local" | sudo tee -a /etc/hosts
```

### Windows (PowerShell as Administrator / como Administrador)
```powershell
Add-Content C:\Windows\System32\drivers\etc\hosts "192.168.2.244 luna.novalink.local"
```

### iOS / Android
Mobile OSes have no editable hosts file. Options / Los móviles no tienen archivo
hosts editable. Opciones:
- Use the IP directly / Usa la IP directamente: `https://192.168.2.244`
  (the certificate also covers the bare IP / el certificado también cubre la IP), or/o
- Ask IT to add the record to the office router's DNS if available / pide a TI
  agregar el registro al DNS del router de la oficina si existe.

---

## 3. Verify / Verificar

Open / Abre **https://luna.novalink.local** — the padlock must show a valid
certificate (no warning). Voice chat requires the padlock: browsers only allow
microphone access on trusted HTTPS. / El candado debe mostrar un certificado
válido (sin advertencia). El chat de voz requiere el candado: los navegadores solo
permiten el micrófono en HTTPS confiable.

Questions → Manuel Campos (mcampos@novalinkmx.com). / Dudas → Manuel Campos.
