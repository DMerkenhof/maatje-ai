# Maatje AI

Een eigen AI-chat die je zelf host. Je kiest per gesprek elk model via OpenRouter, of een lokaal model op je eigen computer met Ollama. Het geheugen is van jou: gewone tekstbestanden op je eigen server, niet bij een AI-bedrijf.

Licht gehouden, zonder franje. Draait prima op een Raspberry Pi.

![Maatje AI](docs/screenshot.png)

## Wat het kan

- **Elk model.** Alle modellen van OpenRouter (Claude, GPT, Gemini, Qwen en honderden andere), met favorieten en per model de denkstand ("effort").
- **Lokale modellen.** Ollama op je eigen computer, ook via Tailscale. Gratis, en je tekst blijft bij jou.
- **Memory.** Profiel, voorkeuren, mensen en bedrijven, projecten en onderwerpen, als markdown-bestanden met git-geschiedenis. Na elk gesprek werkt een model naar keuze ze bij. Wachtwoorden, keys en rekeningnummers komen er nooit in. Alles is te bekijken en aan te passen in de app.
- **Skills.** Vaste werkwijzen in hetzelfde formaat als die van Claude (een map met `SKILL.md`). Upload een `.zip`, `.skill` of `SKILL.md`, of schrijf er een in de app. Een model pakt een skill erbij als hij past, of je kiest er zelf een door je bericht met `/naam` te beginnen.
- **MCP.** Koppel andere apps als tools, zoals Supabase, zoeken op internet (Exa) of elke andere MCP-server met een https-adres. Inloggen via je browser of met een sleutel. Lezen gaat vanzelf; wil een model iets wijzigen, dan vraagt de app eerst toestemming.
- **Telefoon.** Werkt als app op je beginscherm. Antwoorden lopen door als je telefoon in slaap valt.
- **Wachtwoord.** Standaard aan.

De app is in het Nederlands.

## Installeren

Je hebt nodig: een computer of server met [Docker](https://docs.docker.com/get-docker/) (met Compose), en een API-key van [OpenRouter](https://openrouter.ai/keys) als je modellen via OpenRouter wilt gebruiken.

```bash
git clone https://github.com/DMerkenhof/maatje-ai.git
cd maatje-ai
cp .env.example .env
nano .env                      # vul OPENROUTER_API_KEY in
docker compose up -d --build
docker compose logs | grep Wachtwoord
```

Open daarna http://localhost:3080 en log in met het wachtwoord uit de logs. Een eigen wachtwoord kiezen kan met `APP_PASSWORD` in `.env`. Na een wijziging in `.env`: `docker compose up -d`.

### Op je telefoon en andere apparaten

De app luistert standaard alleen op de computer zelf (`127.0.0.1:3080`). De veiligste manier om er van buitenaf bij te komen is [Tailscale](https://tailscale.com): dan kunnen alleen jouw eigen apparaten erbij.

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3080
```

Daarna open je hem op `https://<naam-van-je-computer>.<jouw-tailnet>.ts.net:8443`. Gebruik geen Tailscale Funnel en zet geen poort open in je router: dan staat je chat, met je memory en je keys, op internet.

Gebruik je hem alleen via Tailscale, dan mag het wachtwoord uit met `AUTH=off` in `.env`.

### Lokale modellen (Ollama)

1. Installeer [Ollama](https://ollama.com) op de computer met de modellen en haal een model op, bijvoorbeeld `ollama pull qwen3:8b`.
2. Zet Ollama open voor je netwerk. In de Mac-app is dat Settings › "Expose Ollama to the network". Zonder de app zet je `OLLAMA_HOST=0.0.0.0` voordat Ollama start.
3. Zet in `.env` het adres van die computer: `LOCAL_BASE_URL=http://100.x.y.z:11434` (Tailscale-IP) of het adres op je thuisnetwerk.
4. `docker compose up -d`. De modellen staan dan in de modelkiezer onder "Lokaal".

Staat die computer uit, dan meldt de app dat netjes, en wacht het bijwerken van de memory tot hij er weer is.

## Instellingen (.env)

| Instelling | Wat het doet |
|---|---|
| `OPENROUTER_API_KEY` | Je key van OpenRouter |
| `APP_PASSWORD` | Je wachtwoord. Leeg = de app maakt er zelf een (zie de logs) |
| `AUTH` | `off` = geen wachtwoord. Alleen doen als de app niet vanaf internet of je thuisnetwerk bereikbaar is |
| `DEFAULT_MODEL` | Model voor een nieuwe chat. Leeg = het laatst gekozen model |
| `SYSTEM_PROMPT` | Vaste instructie die elk gesprek meekrijgt |
| `LOCAL_BASE_URL` | Adres van Ollama, bijv. `http://100.x.y.z:11434` |
| `LOCAL_NAME` | Hoe de app die computer noemt, bijv. `Mac` |
| `LOCAL_NUM_CTX` | Hoeveel tekst een lokaal model in één keer ziet (tokens), standaard 32768 |
| `MEMORY_MODEL` | Model dat de memory bijwerkt, bijv. `local/qwen3:8b`. Leeg = het model waarmee je het laatst chatte. Ook te wijzigen in de app |

## Hoe het werkt

### Memory

Alles staat in `data/memory`:

```
profile.md        wie je bent
preferences.md    hoe het model zich moet gedragen
people/           één bestand per persoon of bedrijf
areas/            één bestand per project of lopende zaak
topics/           de rest, per onderwerp
```

Elk gesprek krijgt je profiel en voorkeuren mee, plus de bestanden die bij het gesprek passen (op naam en bijnamen). Modellen met tools kunnen zelf extra bestanden openen. Na elk antwoord kijkt het bijwerk-model of er iets blijvends is gezegd en past de bestanden aan. Elke wijziging komt in git, zodat je kunt terugzien wat er veranderde. Het bijwerken kun je in de app uitzetten.

Heb je al een geheugen in een andere AI, exporteer dat dan naar losse markdown-bestanden in deze indeling en zet ze in `data/memory`.

### Skills

Staan in `data/skills/<naam>/SKILL.md`, eventueel met extra bestanden ernaast. Bovenaan elke `SKILL.md` staan een naam en een omschrijving:

```markdown
---
name: offerte-opvolgen
description: Hoe we een openstaande offerte opvolgen. Gebruik dit als iemand vraagt om een offerte na te bellen of te mailen.
---

# Offerte opvolgen
...
```

Modellen met tools zien de lijst met skills en lezen de juiste zelf. Lokale modellen zonder tools krijgen een skill mee als de naam in je bericht voorkomt. Typ `/` in het berichtvak om er zelf een te kiezen. Skills die scripts draaien of bestanden maken (Excel, PowerPoint) werken hier als tekst: Maatje AI voert geen code uit.

### MCP

Via **MCP** in de zijbalk voeg je servers toe:

- **Supabase**: je database bekijken en vragen erover beantwoorden. Standaard alleen lezen.
- **Op internet zoeken**: via Exa, werkt zonder account.
- **Andere MCP-server**: elk https-adres, met inloggen via je browser of met een sleutel.

Lezen gaat vanzelf. Tools die iets kunnen wijzigen vragen in de chat om toestemming: toestaan, altijd toestaan of weigeren. Per tool is dat later aan te passen.

## Veiligheid

- Alles wat gevoelig is staat in `.env` en `data/`: je keys, je gesprekken, je memory en de logins van MCP-servers. Deel die nooit en zet ze niet in git (ze staan in `.gitignore`).
- Laat het wachtwoord aan, tenzij alleen jouw eigen apparaten erbij kunnen (bijvoorbeeld via Tailscale).
- Na vijf foute wachtwoorden moet je een kwartier wachten.
- Zet Supabase en andere databases bij voorkeur op alleen lezen. Heb je zowel een database als zoeken op internet aan staan en wil je extra voorzichtig zijn, zet dan bij Internet de tool `web_fetch_exa` op vragen (vinkje "zonder vragen" uit).

## Updaten en backup

```bash
git pull
docker compose up -d --build
```

Je gegevens staan in `data/`; neem die map mee in je backup. Stop de container even (`docker compose stop`) voor een backup van `data/chats/chats.db`.

## Zonder Docker

Kan ook, met Node.js 22.13 of nieuwer en git:

```bash
npm ci --omit=dev
cp .env.example .env           # vul in
node --env-file=.env --disable-warning=ExperimentalWarning server/index.js
```

## Licentie

[AGPL-3.0-or-later](LICENSE). Je mag Maatje AI gebruiken, aanpassen en delen. Bied je een aangepaste versie aan anderen aan, ook als dienst via internet, dan moet je die aanpassingen onder dezelfde licentie openbaar maken.

De lettertypes Inter, Poppins en Fraunces vallen onder de SIL Open Font License.
