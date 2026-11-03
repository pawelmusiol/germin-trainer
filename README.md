# 🏃‍♂️🚲 Garmin AI Trainer

Inteligentna aplikacja treningowa (iOS & Android w **React Native / Expo** + backend **Node.js / Express / TypeScript**) łącząca:
- **Dwukierunkową synchronizację z Garmin Connect** (pobieranie HRV, wyniku snu, Body Battery, tętna spoczynkowego i kroków + automatyczne wgrywanie ustrukturyzowanych treningów do kalendarza zegarka Garmin),
- **Sprzęt stacjonarny Matrix (Rower & Bieżnia)** przez protokół **Bluetooth Low Energy FTMS (`0x1826`)** z generowaniem binarnych plików **`.FIT`** wysyłanych do Garmin Connect,
- **Konwerter jednostek na żądanie (Bieg ⮂ Rower)** przeliczający trening biegowy na ekwiwalent kolarski (waty, kadencja, czas) jednym kliknięciem,
- **Silnik Fizjologii (VDOT Jacka Danielsa) + Google Gemini AI** (poranna adaptacja planu, uwzględnianie zmęczenia pracą fizyczną z poprzedniego dnia),
- **Analizę wideo techniki biegu (AI Vision)** automatycznie wplatającą ćwiczenia korygujące (skipy A, monster walk, rytmy kadencji) do rozgrzewek w planie.

---

## ⚡ 1. Jak uruchomić aplikację lokalnie (Szybki Start)

### Krok 1: Zbuduj pakiety współdzielone
W głównym katalogu projektu (`c:\Users\Paweł\Documents\projects\garmin-trainer`) wykonaj:
```powershell
npm run build
```

### Krok 2: Uruchom jednocześnie Backend i Aplikację Mobilną (Expo)
```powershell
npm run dev
```
*(Alternatywnie możesz uruchomić sam serwer: `npm run dev:server` lub samą aplikację mobilną: `npm run dev:mobile`)*.

### Krok 3: Otwórz aplikację na telefonie lub komputerze
Po uruchomieniu `npm run dev:mobile` w terminalu pojawi się **kod QR**:
1. **Na telefonie (Android / iOS)**:
   - Zainstaluj darmową aplikację **Expo Go** ze sklepu Google Play lub App Store.
   - Zeskanuj kod QR z terminala (telefon i komputer muszą być w tej samej sieci Wi-Fi).
2. **Na komputerze / w emulatorze**:
   - Naciśnij `a` w terminalu (aby otworzyć na Android Emulator) lub `w` (jeśli doinstalujesz web support).

---

## 🗄️ 2. Konfiguracja Bazy Danych PostgreSQL (Supabase / Neon) i Kluczy API

1. Otwórz plik [`.env`](file:///c:/Users/Paweł/Documents/projects/garmin-trainer/.env) w głównym katalogu (lub w `apps/server/.env`).
2. Wklej swój adres połączenia z darmowej bazy **Supabase** lub **Neon**:
   ```env
   DATABASE_URL="postgresql://postgres:[TWOJE_HASLO]@[HOST]:5432/postgres?sslmode=require"
   GEMINI_API_KEY="AIzaSy..."
   ```
3. Utwórz tabele w bazie danych jedną komendą:
   ```powershell
   npx prisma db push --schema=apps/server/prisma/schema.prisma
   ```

---

## ☁️ 3. Wdrożenie w Chmurze 24/7 dla Ciebie i Znajomych

1. **Baza danych**: Utwórz darmowy projekt na [Supabase.com](https://supabase.com) lub [Neon.tech](https://neon.tech) i skopiuj `DATABASE_URL`.
2. **Backend (Render.com / Railway.app)**:
   - Projekt zawiera gotowy plik konfiguracyjny [`render.yaml`](file:///c:/Users/Paweł/Documents/projects/garmin-trainer/render.yaml).
   - Połącz repozytorium Git z Renderem / Railway, ustaw zmienną `DATABASE_URL` oraz `GEMINI_API_KEY` (darmowy klucz z Google AI Studio).
3. **Aplikacja mobilna dla znajomych (Expo EAS)**:
   - Projekt posiada skonfigurowany plik [`apps/mobile/eas.json`](file:///c:/Users/Paweł/Documents/projects/garmin-trainer/apps/mobile/eas.json).
   - Aby zbudować instalowalny plik `.apk` na Androida dla znajomych:
     ```powershell
     cd apps/mobile
     npx eas-cli build -p android --profile preview
     ```

---

## 🧪 4. Uruchamianie Testów Automatycznych
```powershell
npm test
```
Uruchamia pełny pakiet **133 testów jednostkowych i integracyjnych** (autoryzacja JWT/bcrypt, szyfrowanie AES-256-GCM, dwukierunkowy Garmin Connect, konwerter Bieg ⮂ Rower, silnik AI, analiza wideo techniki biegu, dekoder ramek Bluetooth FTMS Matrix oraz binarny enkoder `.FIT` z weryfikacją sumy kontrolnej CRC-16).
