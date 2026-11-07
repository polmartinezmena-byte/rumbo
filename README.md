<p align="center"><img src="icon.svg" width="96" alt="Icono de Rumbo"></p>

<h1 align="center">Rumbo</h1>

<p align="center">
  <b>Navegador GPS que funciona sin internet y te aparta de las calles que se inundan.</b><br>
  Descarga tu comunidad autónoma con wifi. Luego tendrás mapa, búsqueda, rutas con guiado por voz y un SOS de un toque
  aunque no haya cobertura, todo calculado en tu propio dispositivo. Sin cuenta, sin servidores y sin rastreo.
</p>

<p align="center">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-instalable-2563eb">
  <img alt="Offline" src="https://img.shields.io/badge/funciona-100%25%20sin%20conexi%C3%B3n-f59e0b">
  <img alt="Ruta segura" src="https://img.shields.io/badge/ruta%20segura-inundaciones-dc2626">
  <img alt="Sin dependencias" src="https://img.shields.io/badge/dependencias-0-0f172a">
  <img alt="Licencia MIT" src="https://img.shields.io/badge/licencia-MIT-0f172a">
</p>

<!-- Sustituye TU-USUARIO y añade un GIF de la demo en docs/demo.gif -->
<p align="center"><a href="https://TU-USUARIO.github.io/rumbo/"><b>▶ Probar la demo</b></a></p>

---

## Qué hace

- 🗺️ **España por comunidades**: descarga tu comunidad (mapa y rutas), la isla que visitas o una zona a medida. Hay además un **mapa general de España** con las carreteras principales para los viajes largos.
- 🧭 **Rutas en el dispositivo** con A\* en un Web Worker. Respeta sentidos únicos y rotondas, y da indicaciones en español («En 200 metros, gira a la derecha por Gran Vía»). Recalcula si te sales de la ruta y mantiene la pantalla encendida.
- 🌧️ **Ruta segura ante inundaciones**: con conexión consulta la lluvia y el caudal de los ríos, y activa sola una ruta que evita badenes, pasos inferiores y calles bajas junto a ríos y ramblas. Sin conexión funciona igual con el botón «Llueve fuerte». [Cómo se calcula ↓](#ruta-segura-ante-inundaciones)
- 🆘 **SOS con cinco botones grandes**: llamar al 112, enviar tu ubicación por SMS a tus contactos de emergencia (no necesita datos), y llevarte al hospital, la gasolinera o la farmacia más cercanos.
- 📷 **Radares fijos, de tramo y semáforos con cámara**: aviso por voz antes de cada uno con su límite. En los tramos calcula tu **velocidad media en directo** y la pone en rojo si la superas.
- 💶 **Con o sin peaje**: la ruta indica los km de pago y deja elegir viendo el tiempo de cada opción (Logroño → Calahorra: 34 min por la AP-68 o 42 min sin peaje).
- ⭐ **Favoritos**, búsqueda local que ignora acentos, «Mi ubicación» al abrir y **modo simulación** para probar rutas desde el ordenador.

## Ruta segura ante inundaciones

Cada tramo de calle recibe una **puntuación de riesgo** cuando se genera el mapa, así que luego no hace falta conexión:

| Señal | Fuente | Por qué |
|---|---|---|
| Altura sobre el cauce más cercano (una versión simple del índice *HAND*) | Relieve de [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) + ríos de OSM | Estar a pocos metros por encima de un río o una rambla cercana es la mejor señal sencilla de que una zona se inunda |
| Hondonadas (más bajo que el entorno en ~450 m) | Relieve | Allí se acumula el agua de lluvia |
| Ramblas y arroyos intermitentes | OSM `intermittent=yes`, `waterway=wadi` | Están secos casi siempre y bajan violentos en una DANA |
| Badenes, túneles y pasos inferiores | OSM `ford`, `tunnel`, `layer<0` | Son las trampas más peligrosas: con lluvia muy fuerte se evitan del todo |
| Vías marcadas como inundables | OSM `flood_prone=yes` | Es conocimiento local |

El coste de cada tramo pasa a ser `tiempo · (1 + K·riesgo²)`, con `K` según la intensidad de la lluvia ([Open-Meteo](https://open-meteo.com)). La app compara la ruta segura con la más rápida y lo explica: *«reduce el recorrido por zonas con riesgo de 2,2 km a 250 m y evita 4 pasos inferiores (+2 min)»* (Logroño, cruzando el Ebro).

> ⚠️ Es una ayuda para elegir ruta, **no un aviso oficial**. La app remite a AEMET, Protección Civil y ES-Alert, y recuerda que nunca hay que cruzar una calle inundada.

## Radares y límites de velocidad

Al generar cada paquete se combinan las **fuentes oficiales** con OpenStreetMap ([`tools/official-radars.mjs`](tools/official-radars.mjs)):

| Fuente | Qué aporta | Licencia |
|---|---|---|
| [DGT · Punto de Acceso Nacional](https://nap.dgt.es/dataset/radares-fijos-dgt) (DATEX II) | 690 cabinas de radar fijo + 47 tramos, en la red estatal (sin Cataluña ni Euskadi) | Licencia libre, citando a la DGT |
| [Servei Català de Trànsit](https://analisi.transparenciacatalunya.cat/en/Transport/Radars-fixos-de-Catalunya/re3y-fftf) | 246 radares fijos con límite | Llicència oberta de Catalunya |
| [Ayuntamiento de Madrid · Radares](https://datos.madrid.es/dataset/300049-0-radares-fijos-moviles) | Radares municipales fijos y de tramo, con límite | CC BY 4.0 |
| [Ayuntamiento de Madrid · Foto-rojo](https://datos.madrid.es/dataset/205193-0-semaforos-foto-rojo) | Semáforos con cámara | Datos abiertos del Ayto. de Madrid |
| OpenStreetMap | El resto: Euskadi, otras ciudades, semáforos con cámara (`highway=speed_camera`, relaciones `type=enforcement`) | ODbL |

Los datos oficiales tienen prioridad. Un radar de OSM a menos de 40 m de uno oficial se trata como el mismo y le aporta su límite y su sentido. Si una fuente no trae el límite, se toma el de la vía.

- **Límite de la vía**: durante la navegación se ve la señal de velocidad máxima y la voz avisa si la superas. Sale de `maxspeed` en OSM (84 % del recorrido en una prueba por Madrid). Cuando falta, se aplica la norma general solo donde no hay duda: 120 en autopista, 30 en calles de un carril por sentido y 20 en plataforma única. Esos límites se dibujan con borde discontinuo porque son estimados.
- **Es legal en España**: los avisadores de radar están permitidos y la DGT publica las ubicaciones. Lo prohibido son los *detectores* y los *inhibidores*.
- **Lo que no puede estar**: los **radares móviles** (no se publican) y los municipales de ciudades que no publican sus datos (Euskadi y Barcelona no tienen una descarga oficial: se usa OSM). Las cabinas de la DGT pueden no tener el radar instalado en todo momento.

| Paquete | Radares |
|---|---|
| Comunidad de Madrid | 385 (34 tramos, 70 semáforos con cámara) |
| La Rioja | 54 |

## Arquitectura

```
 GitHub Actions (mensual)                      Navegador (sin conexión)
 ┌─────────────────────────────────┐          ┌──────────────────────────────────────────┐
 │ Geofabrik .osm.pbf ─► pbf.mjs   │          │ Service Worker ─► app, teselas, estilo    │
 │ AWS relieve ─► dem-node.mjs     │  .rumbo  │ IndexedDB ─► grafos CSR (typed arrays)    │
 │ graph-build.js + flood.js ──────┼──.gz────►│ Worker: router.js (A*, ruta segura, SOS)  │
 │ pack.js (binario + gzip)        │  Pages   │ MapLibre GL + nav.js (voz, desvíos)       │
 └─────────────────────────────────┘          └──────────────────────────────────────────┘
```

| Pieza | Archivo | Detalle |
|---|---|---|
| Grafo | [`js/graph-build.js`](js/graph-build.js) | Lista de adyacencia compacta (CSR). Se engancha solo a la mayor **componente fuertemente conexa** (algoritmo de Kosaraju iterativo), así un sentido único nunca te deja atrapado. |
| Riesgo | [`js/flood.js`](js/flood.js) | Imagen integral para la media del entorno en O(1) y rejilla espacial para buscar cauces cercanos. |
| Rutas | [`js/router.js`](js/router.js) | A\* con heurística admisible, maniobras, rotondas con número de salida y tramos de riesgo. |
| Paquetes | [`js/pack.js`](js/pack.js) · [`tools/`](tools) | Formato binario propio. El lector de PBF de OpenStreetMap y el decodificador PNG están escritos desde cero, **sin dependencias**. |
| Offline | [`sw.js`](sw.js) | *Cache-first* para teselas (la clave no lleva la versión del planeta, así que no caducan) y *network-first* para el estilo. |
| Lluvia | [`js/weather.js`](js/weather.js) | Umbrales inspirados en los de AEMET y caudal de ríos (GloFAS). |

Los paquetes se publican en **GitHub Pages**, el mismo origen que la app, porque los *Releases* de GitHub no permiten descargas desde el navegador (CORS). Cada archivo se trocea en partes de menos de 100 MB.

| Comunidad | Grafo | Comprimido | Tiempo de generación |
|---|---|---|---|
| Ceuta | 17.100 nodos | 0,3 MB | 1 s |
| La Rioja | 159.552 nodos | 3,5 MB | 6 s |

## Ejecutar en local

```bash
node tools/build-region.mjs la-rioja   # genera packs/la-rioja.rumbo.gz (~10 s)
node dev-server.mjs                    # http://localhost:5173
npm test                               # tests del motor (node:test)
```

Para probarlo sin red: DevTools → *Network → Offline* y recarga.

## Publicar

1. Sube el repo a GitHub y en *Settings → Pages* elige **GitHub Actions**.
2. Lanza el workflow **Build region packs** (*Actions → Run workflow*). Genera todas las comunidades y vuelve a publicar la web. Después se repite el día 1 de cada mes.

## Hoja de ruta

- [ ] **CarPlay y Android Auto** con Capacitor y una escena nativa ([plan](docs/CARPLAY.md))
- [ ] Listado oficial de radares de la DGT (NAP) para completar los de OSM
- [ ] Zonas inundables oficiales del SNCZI (MITECO) como capa de riesgo adicional
- [ ] Perfiles a pie y en bici, y avisos de límite de velocidad
- [ ] Números de portal en la búsqueda

## Créditos

Datos © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), extractos de [Geofabrik](https://download.geofabrik.de) · Teselas [OpenFreeMap](https://openfreemap.org) · Relieve [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) · Lluvia y caudales [Open-Meteo](https://open-meteo.com) · Mapa [MapLibre GL JS](https://maplibre.org).
Idea inspirada en [Nomad Pocket](https://github.com/franlindebl/nomad-pocket) (sin reutilizar su código).

## Licencia

[MIT](LICENSE)
