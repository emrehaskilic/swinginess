# Swingg Trading Bot - Full Agent Council (Party Mode)

## Kullanım

Bu dosya `/bmad-party-mode` komutuyla birlikte tüm Swingg ajanlarını aynı anda aktive etmek için kullanılır.

## Ajan Konseyi Yapısı

### Katman 1: Strateji Liderliği
- 🎯 **TradingPM** — Koordinatör, karar arabulucusu
- 📈 **StrategyDesigner** — Strateji mimarı

### Katman 2: Piyasa İstihbaratı
- 📡 **MetricsOrchestrator** — Pipeline şefi
- 🔬 **MicrostructureAnalyst** — OBI/Delta/CVD uzmanı
- 🌊 **RegimeEngine** — Volatilite ve rejim tespiti
- 🤝 **ConsensusArchitect** — Çoklu sinyal uzlaşması

### Katman 3: Risk & Yürütme
- 🛡️ **RiskGuardian** — Güvenlik ve saldırı senaryoları
- 📉 **DrawdownManager** — Kayıp limitleri ve çekiliş yönetimi
- ⚡ **ExecutionEngineer** — Emir planlaması ve dolum kalitesi

### Katman 4: Analitik
- 📊 **QuantAnalyst** — P&L, Sharpe, metrik bütünlüğü
- 🧪 **BacktestEngineer** — Validasyon ve simülasyon

### Katman 5: Geliştirme
- 💻 **BackendDev** — Node.js/TS implementasyonu
- 🏗️ **SystemArchitect** — Sistem entegrasyonu ve mimari
- 🎨 **FrontendDev** — React dashboard

---

## Paralel Çalışma Protokolü

### Standart Tartışma Akışı

Bir sorun gündeme geldiğinde şu sıra izlenir:

```
1. TradingPM → Sorunu tanımla, ilgili ajanları çağır
2. MetricsOrchestrator + MicrostructureAnalyst → Veri doğruluğunu doğrula
3. RegimeEngine → Mevcut piyasa bağlamını belirle
4. StrategyDesigner → Sorunu strateji perspektifinden değerlendir
5. RiskGuardian → Güvenlik ve risk açısından eleştir
6. QuantAnalyst → Sayısal kanıtları kontrol et
7. ConsensusArchitect → Ajanlar arasındaki görüş çakışmalarını çöz
8. BacktestEngineer → Önerilen değişikliği test et
9. BackendDev + FrontendDev → Implementasyona taşı
10. TradingPM → Kararı sonuçlandır, başarı metriğini belirle
```

### Oylama Protokolü

Kritik bir karar (canlıya alma, parametre değişikliği) için:

```
BLOKÖR (herhangi biri HAYIR derse → BLOKE):
  🛡️ RiskGuardian — Güvenlik riski var mı?
  📉 DrawdownManager — Risk limitlerini aşıyor mu?
  🧪 BacktestEngineer — Backtest kanıtı var mı?

DANIŞMAN (ağırlıklı oy):
  📈 StrategyDesigner    → 3 oy
  📡 MetricsOrchestrator → 2 oy
  🌊 RegimeEngine        → 2 oy
  📊 QuantAnalyst        → 2 oy
  ⚡ ExecutionEngineer   → 1 oy
  🤝 ConsensusArchitect  → 1 oy

Toplam: 11 danışman oyu → 6+ evet gerekli (>%50) VE blokör hayırı yok
```

### Anlaşmazlık Çözümü

```
Durum: A ajanı EVET, B ajanı HAYIR
Adım 1: Her ajan kendi itirazını bir cümleyle özetle
Adım 2: TradingPM ortak zemini bul
Adım 3: BacktestEngineer veri ile hakemlik yap
Adım 4: %60+ oy → karar geçerli
Adım 5: Hâlâ anlaşmazlık → Emre karar verir
```

---

## Aktif Sorunlar (Karlılık Öncelikli)

Konsey bu sorunlar üzerine paralel çalışmalı:

| # | Sorun | Öncelik | Sorumlu Ajanlar |
|---|-------|---------|-----------------|
| P1 | RANGING rejimde whipsaw kayıplar | KRİTİK | RegimeEngine + StrategyDesigner + BacktestEngineer |
| P2 | Metrik orkestrasyon sırası hatalı | KRİTİK | MetricsOrchestrator + MicrostructureAnalyst |
| P3 | Profit-lock volatiliteye duyarsız | YÜKSEK | StrategyDesigner + QuantAnalyst + BacktestEngineer |
| P4 | Scale-in zarar eden pozisyona para ekliyor | YÜKSEK | DrawdownManager + ExecutionEngineer + RiskGuardian |
| P5 | Stop-loss sabit %, ATR bazlı değil | YÜKSEK | StrategyDesigner + RegimeEngine |
| P6 | Slippage tahmini yok | ORTA | ExecutionEngineer + MicrostructureAnalyst |
| P7 | Frontend metrikleri gerçek zamanlı değil | ORTA | FrontendDev + SystemArchitect |

---

## Party Mode Başlatma

```
/bmad-party-mode
```

Ya da doğrudan bu koordinasyonu başlatmak için:

> "Tüm Swingg ajanlarını P1 sorununu (RANGING whipsaw) tartışmak için topla. Her ajan kendi perspektifinden analiz yapsın."
