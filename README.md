# Anın Sohbeti

Gerçek zamanlı, rastgele eşleştirmeli sohbet uygulaması.

## Gereksinimler

- [Node.js](https://nodejs.org/) 20.x
- npm 9.x veya üzeri

## Kurulum

1. Bağımlılıkları kurun:
   ```bash
   npm install
   ```
2. İsterseniz örnek ortam dosyasını kopyalayın:
   ```bash
   cp .env.example .env
   ```
3. Varsayılan olarak uygulama 6000 portunu kullanır.

## npm scriptleri

| Komut | Açıklama |
| --- | --- |
| `npm run start` | Üretim modunda sunucuyu başlatır. |
| `npm run dev` | Değişiklikleri izleyerek (`nodemon`) sunucuyu çalıştırır. |
| `npm test` | Önce sunucu entegrasyon testlerini, ardından Cypress uçtan uca testlerini çalıştırır. |
| `npm run test:server` | `node:test` tabanlı sunucu entegrasyon testlerini çalıştırır. |
| `npm run test:e2e` | `npm test` ile aynı uçtan uca test akışını çalıştırır. |
| `npm run test:e2e:open` | Cypress arayüzünü açar. |

## Testler

```bash
npm test
```

Bu akış önce `node:test` ile `/health`, eşleşme, yapılandırılmış mesaj iletimi ve mesaj hız limiti kurallarını doğrular. Ardından test sunucusunu 6100 portunda ayağa kaldırır, `/health` yanıtını kontrol eder ve Cypress testlerini çalıştırır.

Testler; eşleşme, mesajlaşma, hız limiti, hız limiti hata bildirimi, rumuz akışı, "Sonraki" onayı, bağlantı kopmaları ve 2000 karakter sınırı gibi temel sohbet işlevlerini doğrular.

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `6000` | HTTP ve Socket.IO portu |
| `CLIENT_ORIGIN` | `*` | İzin verilen istemci origin listesi; birden fazla değer virgülle ayrılabilir |
| `MESSAGE_RATE_LIMIT_MAX` | `8` | `MESSAGE_RATE_LIMIT_WINDOW_MS` içinde izin verilen mesaj sayısı |
| `MESSAGE_RATE_LIMIT_WINDOW_MS` | `5000` | Mesaj hız limiti penceresi |
| `JOIN_RATE_LIMIT_MAX` | `6` | `JOIN_RATE_LIMIT_WINDOW_MS` içinde izin verilen `join/next` isteği |
| `JOIN_RATE_LIMIT_WINDOW_MS` | `15000` | Eşleşme arama hız limiti penceresi |
| `CALL_RATE_LIMIT_MAX` | `12` | Çağrı olayları için temel hız limiti |
| `CALL_RATE_LIMIT_WINDOW_MS` | `10000` | Çağrı olayları hız limiti penceresi |

## Android WebView uygulamasını arşivleme

Android projesinin tamamını tek bir `.zip` arşivi haline getirmek için depo kökünden aşağıdaki komutu çalıştırabilirsiniz:

```bash
scripts/make-zip.sh
```

Komut `dist/anin-sohbeti-android.zip` dosyasını üretir. Arşiv, Gradle'ın indireceği geçici dosyalar ve makineye özel ayarları içermez.

## Docker ile çalışma

Uygulamayı Docker içerisinde çalıştırmak için:

```bash
docker build -t aninsohbeti .
docker run -p 6000:6000 aninsohbeti
```

Test odaklı bir imaj oluşturmak için geliştirme bağımlılıklarını da dahil edebilirsiniz:

```bash
docker build --build-arg NODE_ENV=development -t aninsohbeti-dev .
```

## CI

GitHub Actions iş akışı [ci.yml](/opt/web-projects/aninsohbeti/.github/workflows/ci.yml) ile `npm test` komutunu her `push` ve `pull_request` olayında çalıştırır.

## Güvenlik Notları

- Sunucu `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` ve `Permissions-Policy` başlıklarını gönderir.
- Socket.IO el sıkışması `CLIENT_ORIGIN` tanımına göre origin doğrulaması yapar. Üretimde `CLIENT_ORIGIN=*` yerine açık origin listesi kullanın.

## Sorun Giderme

- 6000 portu kullanımda ise farklı bir porta yönlendirmek için `docker run -p <yerel_port>:6000` şeklinde çalıştırın.
- Bağımlılıkları güncelledikten sonra Docker imajını tekrar oluşturmayı unutmayın.
- Cypress çalışma sırasında GUI gerektirmez; testler `cypress run` ile headless şekilde yürütülür.
