# NT8 Bot Pseudo-Spec

## Amaç

Bu doküman, `bot.mp4` videosunda görünen NinjaTrader 8 stratejisinin davranışını videoya dayalı olarak yaklaşık bir teknik spesifikasyona dönüştürür.

Bu bir kaynak kod spesifikasyonu değildir. Buradaki maddeler:

- videoda doğrudan görülen davranışlar,
- davranıştan çıkarılmış makul kurallar,
- ve halen belirsiz kalan alanlar

olarak ayrıştırılmıştır.

## Kaynak ve Kapsam

Analiz kaynağı:

- Yerel video: `C:\Users\emrehaskilic\Desktop\bot.mp4`

Videoda görülen bağlam:

- Platform: NinjaTrader 8
- Enstrüman: `CL 10-21`
- Grafik tipi: `4 UniRenko T4R1006`
- Çalışma modu: `Playback / Market Replay`
- Tarih aralığı: yaklaşık `22.08.2021` - `27.08.2021`
- Strateji adı satırında görülen ifade: `AlgoN 2 Strategy Beta/DValueArea(...)`

## Güven Seviyesi

### Yüksek güven

- Bot, fiyat yapısını `HH / HL / LH / LL` olarak etiketliyor.
- Bot yatay seviye ve kutu/zone benzeri referans alanları çiziyor.
- Bot kendi stop/target emirlerini yönetiyor.
- Bot en az bir senaryoda long pozisyonu kademeli biçimde taşıyor ve stop seviyesini yukarı alıyor.
- Bot 4 kontrata kadar açık pozisyon tutabiliyor.

### Orta güven

- Giriş mantığı market structure break + value area/zone teyidi kombinasyonu.
- Stop seviyesi son anlamlı swing low/high ya da zone sınırına göre trail ediliyor.
- Pozisyon eklemeleri aynı trend içinde add-on mantığıyla yapılıyor.

### Düşük güven

- Parametrelerin tam anlamı.
- Kısa taraf kuralları bire bir simetrik mi.
- Günlük zarar veya ardışık kayıp limiti tam olarak nasıl çalışıyor.

## Strateji Özeti

Strateji, UniRenko grafikte swing yapısını izleyen, yapısal kırılım sonrası bir değer alanı / zone çerçevesi içinde pozisyon alan ve açık pozisyonu swing tabanlı stop trail ile yöneten bir trend-following sistem gibi davranıyor.

Videoda görülen örnek akış:

1. Piyasa önce düşüş yapısında ilerliyor ve ardışık `LH` ile `LL` üretiyor.
2. Dip bölgede akış yavaşlıyor ve yapısal dönüş başlıyor.
3. Bot, dönüş sonrası long pozisyon açıyor.
4. Pozisyon en fazla 4 kontrata kadar taşınıyor veya eklemelerle bu boyuta ulaşıyor.
5. Üstte limit target, altta stop market/stop emri tutuluyor.
6. Yeni `HL` oluştukça stop yukarı alınıyor.
7. Trend devam ederse bot winner pozisyonu uzun süre taşıyor.

## Gözlenen Görsel Bileşenler

### 1. Piyasa yapısı etiketleri

Grafikte şu etiketler var:

- `HH`: Higher High
- `HL`: Higher Low
- `LH`: Lower High
- `LL`: Lower Low
- Bazen `DT`: olası Double Top veya özel structure etiketi

Bu etiketlerin yanında aynı fiyat seviyesinin sağa doğru uzatılmış dotted çizgileri görülüyor.

Muhtemel amaç:

- önceki swing referanslarını canlı tutmak,
- break of structure / continuation / failure tespiti yapmak,
- stop ve hedef alanlarını bağlamsallaştırmak.

### 2. Zone / değer alanı çizimleri

Grafikte birkaç farklı yatay ve dikdörtgensel yapı var:

- kalın bej step-box çizgiler,
- turkuaz yatay seviyeler,
- kırmızı yatay seviyeler,
- sarı/oranj dotted seviyeler,
- zaman zaman kalın yeşil yatay çizgiler.

Muhtemel yorum:

- bej step-box: aktif referans zone veya regime box,
- turkuaz: üst likidite / referans high / target band,
- kırmızı: risk invalidation veya ana destek/direnç,
- sarı/oranj dotted: ara swing teyit seviyeleri,
- kalın yeşil: aktif trade yönetim seviyesi veya ana bias seviyesi.

## Gözlenen Operasyonel Davranış

### Pozisyon ve panel bilgisi

Sol üst panelde görülen alanlar:

- `Açık Pozisyon`
- `Anlık Kazanç`
- `Kazanç`
- `Günlük Kazanç`
- `Günlük Olumlu`
- `Günlük Olumsuz`
- `Trade Status`
- `Stop Loss`

Bu da stratejinin kendi iç muhasebe ve istatistik ekranını çizdiğini gösteriyor.

### Emir yönetimi

Sağ tarafta NT8 Chart Trader üzerinden görülenler:

- `Sell LMT` etiketiyle target emri,
- `Sell STP` etiketiyle protective stop,
- pozisyon açıkken ortalama giriş fiyatı,
- açık PnL,
- açık kontrat sayısı.

`ATM Strategy = None` göründüğü için stop/target mantığı büyük olasılıkla strategy-managed order olarak üretiliyor.

## Pseudo-Spec

### 1. Çalışma ortamı

#### Varsayılan konfigürasyon

- Platform: NinjaTrader 8
- Chart type: UniRenko
- Instrument: CL
- Time filter: strateji parametreli, muhtemelen belirli seans aralıklarında aktif
- Replay ve live modda çalışabilecek yapı

#### Olası input parametreleri

Videoda isim satırında görülen parametre dizisinden yaklaşık olarak:

- `swingStrength`
- `zoneLookback`
- `maxContracts`
- `enableLong`
- `enableShort`
- `sessionStart`
- `sessionEnd`
- `riskMultiplier`
- `rewardMultiplier`
- `useVolumeOrVOC`
- `valueAreaLength`

Not:
Parametre isimleri videodan okunamıyor; bu alanlar işlevsel tahmindir.

### 2. İç durum modeli

Strateji en az şu state alanlarını tutuyor gibi görünüyor:

- `marketBias`: `Bullish | Bearish | Neutral`
- `lastHH`
- `lastHL`
- `lastLH`
- `lastLL`
- `activeLongZone`
- `activeShortZone`
- `openPositionContracts`
- `avgEntryPrice`
- `activeStopPrice`
- `activeTargetPrice`
- `dailyWinCount`
- `dailyLossCount`
- `sessionPnL`
- `tradeStatus`

### 3. Swing tespit mantığı

#### Fonksiyonel amaç

Her yeni renko brick kapanışında yerel swing high / low tespiti yapılır.

#### Beklenen davranış

- Yeni swing high, önceki önemli high üstündeyse `HH`
- Yeni swing high, önceki önemli high altında kalıyorsa `LH`
- Yeni swing low, önceki önemli low üstündeyse `HL`
- Yeni swing low, önceki önemli low altında kalıyorsa `LL`

#### Yan etkiler

- tespit edilen swing seviyesi grafiğe etiketlenir,
- seviye sağa doğru uzatılır,
- yapı değişimi için referans olarak saklanır.

### 4. Bias belirleme

#### Bullish bias

Muhtemel koşullar:

- son yapı `LL/LH` dizisinden `HL/HH` dizisine dönmüş olmalı,
- fiyat önemli bir `LH` veya zone üstüne çıkmış olmalı,
- aktif invalidation seviyesi son anlamlı `HL` altında kalmalı.

#### Bearish bias

Muhtemel koşullar:

- son yapı `HH/HL` dizisinden `LH/LL` dizisine dönmüş olmalı,
- fiyat önemli bir `HL` veya zone altına inmiş olmalı,
- aktif invalidation seviyesi son anlamlı `LH` üstünde kalmalı.

### 5. Zone / DValueArea üretimi

Videodan çıkarılan yaklaşık mantık:

- geçmiş swing'lerden bir referans aralık oluşturulur,
- bu aralık yatay kutu veya basamak biçiminde çizilir,
- fiyat bu alanın dışına çıktığında bias dönüşümü teyit edilir,
- alanın kenarları giriş, stop veya yeniden test seviyeleri olarak kullanılır.

Muhtemel pseudocode:

```text
zoneHigh = highest(structureWindow)
zoneLow = lowest(structureWindow)
zoneMid = (zoneHigh + zoneLow) / 2

if trend is bearish and price reclaims zoneMid/zoneHigh:
    prepare long scenario

if trend is bullish and price loses zoneMid/zoneLow:
    prepare short scenario
```

### 6. Long giriş mantığı

Videoda net görülen örnek için tahmini kural:

#### Hazırlık

- Piyasa önce düşüş trendinde.
- Dip sonrası en az bir anlamlı kırılım oluşuyor.
- Son `LH` seviyesi yukarı kırılıyor veya zone reclaim ediliyor.

#### Tetik

Long giriş aşağıdaki kombinasyonlardan biriyle oluşuyor olabilir:

- `Break of structure up`
- `HL` oluştuktan sonra yukarı devam teyidi
- zone üst sınırının reclaim edilmesi
- değer alanı içine geri dönüş sonrası yukarı çıkış

#### Pseudo-flow

```text
if no open position:
    if bullishStructureShiftDetected:
        if price closes above triggerLevel:
            enter long initialSize
            place stop below invalidationLow
            place target above liquidityReference
```

### 7. Short giriş mantığı

Videoda short işlemin tam açılışı net görünmüyor; ancak sistem büyük olasılıkla simetrik çalışıyor.

```text
if no open position:
    if bearishStructureShiftDetected:
        if price closes below triggerLevel:
            enter short initialSize
            place stop above invalidationHigh
            place target below liquidityReference
```

### 8. Pozisyon büyütme / add-on

Videoda birden fazla fiyat seviyesinde etiket kümeleri görülüyor ve açık pozisyon 4 kontrata kadar taşınıyor.

Bu nedenle sistem muhtemelen:

- tek seferde 4 kontrat açmıyor,
- trend teyidi geldikçe ek giriş yapıyor,
- veya ilk girişten kısa süre sonra pozisyonu hedef boyuta tamamlıyor.

Muhtemel kural:

```text
if position is long and bullish continuation confirms:
    if openPositionContracts < maxContracts:
        add one contract
        recalculate averageEntry
        keep common stop logic
```

### 9. Stop loss yönetimi

Videoda stop seviyesinin zaman içinde yükseldiği açık.

Muhtemel kurallar:

- ilk stop: girişi invalid kılan swing low altı
- trailing stop: yeni `HL` oluştukça stop bir önceki `HL` altına taşınır
- agresif trail: pozisyon kâra geçince break-even üstüne alınır

Örnek gözlem:

- yaklaşık `12:20:11` civarında 4 lot long pozisyonda stop `63.19`
- yaklaşık `16:55:11` civarında stop `63.86`

Bu da trend boyunca stop'un aşağıdan yukarı taşındığını gösterir.

Pseudo-flow:

```text
if long position:
    if new HL confirmed:
        stop = max(currentStop, HL - stopOffset)

if short position:
    if new LH confirmed:
        stop = min(currentStop, LH + stopOffset)
```

### 10. Target yönetimi

Videoda üstte tek bir ana limit hedef görülüyor.

Muhtemel seçenekler:

- sabit R-multiple hedef,
- önceki major high / liquidity pool hedefi,
- zone projection hedefi.

Gözlenen örnekler:

- ortalama giriş yaklaşık `63.70`, hedef yaklaşık `65.20`
- ortalama giriş yaklaşık `64.02`, hedef yaklaşık `65.52`

Bu hedeflerin belirgin swing high üstü likidite veya zone expansion tabanlı olması muhtemeldir.

### 11. Trade lifecycle

#### Durumlar

- `Idle`
- `SetupPending`
- `Triggered`
- `Open`
- `Managing`
- `ExitPending`
- `Closed`

#### Olası geçişler

```text
Idle -> SetupPending
SetupPending -> Triggered
Triggered -> Open
Open -> Managing
Managing -> Closed
```

### 12. Günlük risk ve performans takibi

Sol panelde günlük olumlu/olumsuz adet ve günlük kazanç alanları var.

Bu nedenle strateji muhtemelen:

- günlük trade sayısını sayıyor,
- günlük PnL tutuyor,
- gün bazlı risk limiti uygulayabiliyor.

Olası korumalar:

- maksimum günlük zarar sonrası yeni işlem durdurma,
- maksimum ardışık kayıp sonrası duraklama,
- seans sonu pozisyon kapatma.

Videodan bu kuralların tetiklendiği net görülmüyor; sadece altyapı izi var.

## Uygulama Seviyesi Pseudocode

```text
OnBarClose():
    updateSessionStats()
    detectSwingPoints()
    classifyStructureAsHHHLHLL()
    updateReferenceLines()
    updateZoneModel()
    updateBias()

    if position is flat:
        if tradingWindowOpen and riskLimitsAllowTrading:
            if bullishSetupReady and longEnabled:
                if longTriggerConfirmed:
                    EnterLong(size)
                    stopPrice = computeInitialLongStop()
                    targetPrice = computeLongTarget()
                    submitLongBracket(stopPrice, targetPrice)

            if bearishSetupReady and shortEnabled:
                if shortTriggerConfirmed:
                    EnterShort(size)
                    stopPrice = computeInitialShortStop()
                    targetPrice = computeShortTarget()
                    submitShortBracket(stopPrice, targetPrice)

    else:
        manageOpenPosition()
        maybeAddOn()
        trailStopFromNewStructure()
        updateVisualStatusPanel()
```

### `manageOpenPosition()`

```text
if long:
    if newHLConfirmed:
        raise stop
    if targetHit:
        exit all or partial
    if bearishStructureFailure:
        flatten

if short:
    if newLHConfirmed:
        lower stop
    if targetHit:
        exit all or partial
    if bullishStructureFailure:
        flatten
```

## Beklenen Çizim Kuralları

Strateji grafiğe aşağıdakileri çizer:

- Swing etiketleri (`HH`, `HL`, `LH`, `LL`)
- Aktif zone kutuları
- Uzatılmış yatay seviye çizgileri
- Giriş, stop ve hedef etiketleri
- Sol üst performans paneli

## Bilinmeyenler

Videodan netleşmeyen alanlar:

- DValueArea algoritması tam olarak ne hesaplıyor
- Parametre listesinin tam isimleri
- Entry'nin bar close mu intrabar mı tetiklendiği
- Add-on sayısı ve ölçekleme kuralı
- Kısmi kâr alımı olup olmadığı
- Short tarafın bire bir simetrik olup olmadığı
- Haber/seans filtresi bulunup bulunmadığı

## Uygulama İçin Minimum Yeniden Yapım Spesifikasyonu

Eğer bu davranış yeniden inşa edilecekse, ilk sürüm şu sade kurallarla başlanabilir:

1. UniRenko üzerinde swing high/low tespiti.
2. `HH/HL/LH/LL` etiketleme.
3. Son 20-50 swing referansından zone üretimi.
4. Structure shift sonrası breakout/reclaim girişi.
5. Başlangıç pozisyonu 1 kontrat, maksimum 4 kontrat.
6. Stop'u son swing altı/üstüne koyma.
7. Yeni `HL` veya `LH` oluştukça trailing stop.
8. Hedefi major liquidity high/low veya sabit `R` ile koyma.
9. Günlük PnL ve trade sayısını panelde gösterme.

## Sonuç

Videodaki bot en güçlü ihtimalle:

- market structure okuyan,
- value area / zone bağlamı kullanan,
- structure shift sonrası trade açan,
- pozisyonu swing tabanlı trail stop ile yöneten,
- winner trade'leri uzatmaya çalışan

bir NT8 trend-following stratejisidir.

Bu doküman doğrudan kod üretmek için yeterli değildir, fakat davranışsal yeniden yapım ve reverse engineering için işlevsel bir başlangıç spesifikasyonu sağlar.
