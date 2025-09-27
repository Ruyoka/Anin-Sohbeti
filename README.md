# Ekşi Anın Sohbeti

Gerçek zamanlı, rastgele eşleştirmeli sohbet uygulaması. WhatsApp tarzı arayüzle, yabancılarla kolayca bağlantı kurmanızı sağlar.

## Gereksinimler

- [Node.js](https://nodejs.org/) 20.x
- npm 9.x veya üzeri

## Kurulum

1. Bağımlılıkları kurun:
   ```bash
   npm install
   ```
2. Varsayılan olarak uygulama 6000 portunu kullanır.

## npm scriptleri

| Komut | Açıklama |
| --- | --- |
| `npm run start` | Üretim modunda sunucuyu başlatır. |
| `npm run dev` | Değişiklikleri izleyerek (`nodemon`) sunucuyu çalıştırır. |
| `npm run test:e2e` | Çalışmakta olan sunucuya karşı Cypress uçtan uca testlerini çalıştırır. |

> **Not:** `npm run test:e2e` komutu, ayrı bir terminalde `PORT=6100 npm run start` (veya `PORT=6100 npm run dev`) ile sunucunun başlatılmış olmasını gerektirir.

## Testler

1. Yeni bir terminalde (tarayıcıların güvenli port kısıtlamalarını aşmak için) 6100 portunda sunucuyu başlatın:
   ```bash
   PORT=6100 npm run start
   ```
2. Başka bir terminalde Cypress testlerini çalıştırın:
   ```bash
   npm run test:e2e
   ```

Testler; eşleşme, mesajlaşma, "Sonraki" akışı, bağlantı kopmaları ve 2000 karakter sınırı gibi temel sohbet işlevlerini doğrular.

## Proje Geliştirme Önerileri

### Genel
- Kullanıcıların uygunsuz davranışları bildirebileceği bir raporlama akışı ekleyin.
- Mobil uygulama deneyimini güçlendirmek için PWA (Progressive Web App) desteği planlayın.

### Frontend
- Bileşenleri yeniden kullanılabilir kılmak için React veya Svelte gibi bir ön yüz çatı sistemi ile yeniden yazmayı değerlendirin.
- Mesajlar için gönderilme zamanı, okunma bilgisi ve yazıyor göstergesi ekleyin.
- Karanlık mod desteği ve özelleştirilebilir tema seçenekleri sağlayarak erişilebilirliği artırın.

### Backend
- Eşleştirme sırasında kullanıcıların tercihlerini (ör. dil, ilgi alanları) kullanmak için bir eşleştirme algoritması geliştirin.
- Oturum yönetimi ve oran sınırlama (rate limiting) ile kötüye kullanımı azaltın.
- Ölçeklendirme senaryoları için Redis tabanlı bir kuyruk veya Socket.IO adapter yapılandırması ekleyin.

### Test ve DevOps
- Cypress test kapsamını, mobil görünüm doğrulamaları ve hata durumlarıyla genişletin.
- Backend için Jest veya Vitest kullanarak ünite/integrasyon testleri ekleyin.
- GitHub Actions gibi CI/CD hatları kurarak otomatik test ve dağıtım süreçleri oluşturun.

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

## Sorun Giderme

- 6000 portu kullanımda ise farklı bir porta yönlendirmek için `docker run -p <yerel_port>:6000` şeklinde çalıştırın.
- Bağımlılıkları güncelledikten sonra Docker imajını tekrar oluşturmayı unutmayın.
- Cypress çalışma sırasında GUI gerektirmez; testler `cypress run` ile headless şekilde yürütülür.
