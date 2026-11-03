# Garmin AI Trainer – Zaktualizowane Założenia, Uwagi i Backlog

Data aktualizacji: 2026-11-02  
Status projektu: W trakcie dopracowywania fazy MVP (Faza 2–5)

---

## 1. Kluczowe Założenia Projektowe (Stan Docelowy)

1. **Przeznaczenie i Użytkownicy**:
   - Narzędzie do adaptacyjnego trenowania pod konkretny cel (5 km, 10 km, Półmaraton, Maraton) zintegrowane z ekosystemem Garmin.
   - Tryb personalny + znajomi (docelowo multi-tenant; obecnie szybki tryb jednoosobowy).
2. **Dobór Obciążeń i Progresja**:
   - **Oddzielenie stanu aktualnego od celu**: Treningi w danym tygodniu ZAWSZE wyliczane są z aktualnego poziomu (`Current VDOT`), a nie z docelowego wyniku marzeń (`Target VDOT`).
   - Twardy limit wzrostu objętości: maksymalnie **+10% kilometrażu tygodniowo**.
3. **Elastyczność Dyscyplin pod KONKRETNY DZIEŃ**:
   - Użytkownik w kalendarzu przy każdym konkretnym dniu może wybrać/zmienić modalność:
     - **Bieg** (na zewnątrz z GPS lub na bieżni),
     - **Rower** (stacjonarny Matrix lub na zewnątrz; automatyczny przelicznik watów i czasu ~1.33x),
     - **Hybryda** (trening łączony tzw. *brick* – rower tlenowy + bieg w tempie docelowym).
4. **Integracja z Garmin Connect**:
   - **Pobieranie (Ingest)**: Nocne HRV, wynik snu, tętno spoczynkowe, Body Battery, kroki dzienne, historia aktywności.
   - **Wgrywanie (Upload)**: Ustrukturyzowane treningi do kalendarza Garmina (zegarek prowadzi alertami tempa/tętna) + pliki binarne `.FIT` z rowerka i bieżni Matrix.
5. **Sprzęt Stacjonarny Matrix (Indoor Gym)**:
   - Połączenie Bluetooth FTMS (`0x1826`) lub szybki formularz ręczny (Fallback).
   - Generowanie poprawnego pliku `.FIT` z sumą kontrolną CRC-16.
6. **Adaptacja Poranna i Zmęczenie Pracą Fizyczną**:
   - Wykrywanie zmęczenia na podstawie danych Garmina (kroki poza treningiem, stres) + suwak zmęczenia (1–5) z możliwością swobodnego zwiększania i zmniejszania.
   - Propozycja lżejszego treningu lub zamiany na rower przy niskiej regeneracji.

---

## 2. Zgłoszone Uwagi i Błędy z Testów Użytkownika (Issue Tracking)

| ID | Kategoria | Opis problemu | Wymagane rozwiązanie |
|---|---|---|---|
| **ISSUE-01** | **UI / Layout** | Brak górnego marginesu – aplikacja wchodzi pod pasek powiadomień / wcięcie aparatu. | Zastosowanie bezpiecznego marginesu górnego (`StatusBar.currentHeight` na Androidzie / `SafeAreaView`). |
| **ISSUE-02** | **UI / UX** | Komunikaty o statusie (np. „Połączony”, e-mail) wychodzą poza ekran telefonu. | Użycie `flexShrink: 1`, elastycznych kontenerów i zawijania tekstu. |
| **ISSUE-03** | **UX / Garmin** | Po zalogowaniu do Garmina aplikacja nadal wyświetla pola na login i hasło. | Ukrycie formularza logowania po nawiązaniu połączenia; wyświetlenie karty połączonego konta z przyciskiem „Rozłącz” i „Pobierz dane”. |
| **ISSUE-04** | **Plan / Modalność** | Brak możliwości wyboru modalności (Bieg / Rower / Hybryda) pod **konkretny dzień** w kalendarzu. | Dodanie 3-pozycyjnego przełącznika `[Bieg]` / `[Rower]` / `[Hybryda]` na karcie wybranego dnia. |
| **ISSUE-05** | **Fizjologia / Garmin** | Przycisk „Wylicz mój obecny poziom z Garmina” zwracał dziwne wartości i nic nie zapisywał. | Poprawa kalkulacji z aktywności Garmina (uwzględnienie tętna sub recovery), wyświetlenie czytelnego uzasadnienia i automatyczny zapis do bazy. |
| **ISSUE-06** | **AI / Adaptacja** | Zaznaczenie zmęczenia na wysokie (4-5) adaptowało plan, ale zmniejszenie go z powrotem nie przywracało normalnego treningu. | Dodanie dwukierunkowej adaptacji: przy powrocie do zmęczenia 1-2 możliwość przywrócenia pełnego pierwotnego planu. |

---

## 3. Co jeszcze trzeba zrobić (Backlog & Roadmap)

### Priorytet 1 (Natychmiast – Naprawa UX i Logiki):
- [x] Spisanie aktualnego rejestru założeń i uwag do pliku.
- [ ] Poprawienie marginesu górnego (Safe Area / notch) i obcinania tekstów w UI.
- [ ] Schowanie formularza logowania Garmina, gdy konto jest już połączone.
- [ ] Dodanie przełącznika modalności pod konkretny dzień: **Bieg / Rower / Hybryda**.
- [ ] Usprawnienie i automatyczny zapis wyliczania aktualnego VDOT z biegów w Garminie.
- [ ] Umożliwienie cofnięcia adaptacji zmęczenia i powrotu do pełnego planu.

### Priorytet 2 (Fizyczne Połączenia Zewnętrzne):
- [ ] Prawdziwe zapytania HTTP do Google Gemini API (`GEMINI_API_KEY`) dla narracji trenerskiej.
- [ ] Zastąpienie symulacji BLE natywnym modułem Bluetooth w Expo Dev Client.
- [ ] Wygodny modal formularza ręcznego dla rowerka/bieżni Matrix (gdy brak BLE).
- [ ] Fizyczny upload multipart pliku `.FIT` do endpointu Garmin Connect Upload API.

### Priorytet 3 (Funkcje Długoterminowe i Multi-User):
- [ ] Przywrócenie ekranów rejestracji dla znajomych (przejście z trybu Bootstrap na pełny Multi-tenant).
- [ ] Poranny scheduler (Cron o 07:00 na serwerze) wysyłający powiadomienia push o gotowości.
- [ ] Moduł wgrywania pliku wideo biegu do multimodalnego modelu Gemini Vision.
