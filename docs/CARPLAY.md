# CarPlay (y Android Auto): plan

## Por qué no funciona hoy

CarPlay **no ejecuta webs ni PWAs**. Solo muestra apps nativas de iOS que Apple autoriza con un
permiso específico (*CarPlay Navigation App entitlement*). Lo mismo pasa con Android Auto: hace falta
una app nativa con la *Car App Library* y la categoría de navegación, que Google revisa.

## Requisitos

| | CarPlay | Android Auto |
|---|---|---|
| Cuenta | Apple Developer (99 €/año) | Google Play Console (25 € una vez) |
| Equipo | Mac con Xcode | Cualquier PC con Android Studio |
| Permiso | Solicitar el entitlement de navegación a Apple (formulario, revisión manual) | Revisión de calidad para apps de coche |
| Pruebas | Simulador de CarPlay en Xcode | Desktop Head Unit (DHU) |

## Cómo llegar sin reescribir la app

El motor ya está separado de la interfaz: `graph-build.js`, `router.js`, `flood.js`, `pack.js` y
`nav.js` son JavaScript puro, sin DOM. El camino propuesto es este:

1. **Empaquetar la PWA con [Capacitor](https://capacitorjs.com)**. Se obtiene la app de iOS/Android
   reutilizando el 100 % del código actual (mapa, rutas, SOS, ruta segura).
2. **Escena de CarPlay nativa (Swift)**: `CPTemplateApplicationSceneDelegate` con un
   `CPMapTemplate`. El mapa de la pantalla del coche se dibuja con MapLibre Native y las mismas teselas.
3. **Puente JS ↔ nativo**: la app web calcula la ruta (como ahora) y envía al lado nativo la
   geometría y las maniobras (`steps`, ya con texto en español y ángulo). En CarPlay se muestran con
   `CPManeuver`, `CPTravelEstimates` y avisos `CPNavigationAlert` para los tramos con riesgo de
   inundación.
4. **Android Auto** con el mismo puente: `NavigationTemplate` de la Car App Library.

Estimación: de 2 a 4 semanas de trabajo, más el tiempo de aprobación de Apple.
