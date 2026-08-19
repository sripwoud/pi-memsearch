# Changelog

## [1.2.1](https://github.com/sripwoud/pi-memsearch/compare/v1.2.0...v1.2.1) (2026-08-19)


### Miscellaneous Chores

* release 1.2.1 for the restructured README ([18f5620](https://github.com/sripwoud/pi-memsearch/commit/18f562029dcf8c5fc91618f9ee410fe428df77f1))

## [1.2.0](https://github.com/sripwoud/pi-memsearch/compare/v1.1.1...v1.2.0) (2026-08-18)


### Features

* **tools:** add memory_transcript for l3 recall ([#68](https://github.com/sripwoud/pi-memsearch/issues/68)) ([72937eb](https://github.com/sripwoud/pi-memsearch/commit/72937ebd415917055a19603a9b619f1050279c74))
* **tools:** declare promptSnippet on the six memory tools ([#61](https://github.com/sripwoud/pi-memsearch/issues/61)) ([cb4acf7](https://github.com/sripwoud/pi-memsearch/commit/cb4acf7dc4282c9b7f7dcac1ca31d8c27f598d99))
* **tools:** surface pending skill candidates in memory_status ([#63](https://github.com/sripwoud/pi-memsearch/issues/63)) ([75a1302](https://github.com/sripwoud/pi-memsearch/commit/75a1302b9494d0805d99041efcd189f9c9d9f3a8)), closes [#51](https://github.com/sripwoud/pi-memsearch/issues/51)

## [1.1.1](https://github.com/sripwoud/pi-memsearch/compare/v1.1.0...v1.1.1) (2026-08-18)


### Bug Fixes

* **exec:** force utf-8 on memsearch child streams ([#57](https://github.com/sripwoud/pi-memsearch/issues/57)) ([a24a6ee](https://github.com/sripwoud/pi-memsearch/commit/a24a6ee165c72ee775384a7a9dbf1822ab3d2427))
* **exec:** run memsearch children at the repository directory ([#53](https://github.com/sripwoud/pi-memsearch/issues/53)) ([7edc294](https://github.com/sripwoud/pi-memsearch/commit/7edc294b8893838b734bd0ec079a0347072d505d))

## [1.1.0](https://github.com/sripwoud/pi-memsearch/compare/v1.0.0...v1.1.0) (2026-08-15)


### Features

* **auto-context:** per-prompt memory injection via warm sidecar ([#45](https://github.com/sripwoud/pi-memsearch/issues/45)) ([2090a15](https://github.com/sripwoud/pi-memsearch/commit/2090a15987d749667e3f59f932ceac2e71557665))
* **recall:** add opt-in cross-repo recall ([#36](https://github.com/sripwoud/pi-memsearch/issues/36)) ([0153e77](https://github.com/sripwoud/pi-memsearch/commit/0153e77a72f774f0473466da45a439cdebdc8bb5))
* **skill-drafting:** ship procedural-memory skill drafting ([#44](https://github.com/sripwoud/pi-memsearch/issues/44)) ([6a73647](https://github.com/sripwoud/pi-memsearch/commit/6a73647bbd2a24a4b30067798d4983ef303aef31))
* **tools:** add memory_compact for on-demand memory compaction ([#39](https://github.com/sripwoud/pi-memsearch/issues/39)) ([905f927](https://github.com/sripwoud/pi-memsearch/commit/905f927c00920a70d1080fe6a80067ca63d936ab))
* **tools:** add memory_forget with chunk and date-time addressing ([#37](https://github.com/sripwoud/pi-memsearch/issues/37)) ([80a1c65](https://github.com/sripwoud/pi-memsearch/commit/80a1c65d7d8366d8a8e08e9efdb3c6c242d3caf3))
* **tools:** memory_forget redacts compact blocks by chunk_hash ([#46](https://github.com/sripwoud/pi-memsearch/issues/46)) ([ff9993a](https://github.com/sripwoud/pi-memsearch/commit/ff9993a0e90a8604233cf4c70aa00e46bddcf671))


### Bug Fixes

* surface queue waits and abort in-flight commands at shutdown ([#47](https://github.com/sripwoud/pi-memsearch/issues/47)) ([a6dd14a](https://github.com/sripwoud/pi-memsearch/commit/a6dd14a3d0739520efd323e1e20addfd3164f23b))

## [1.0.0](https://github.com/sripwoud/pi-memsearch/compare/v0.2.0-beta...v1.0.0) (2026-08-14)


### Documentation

* publish benchmark evidence, add reader on-ramps and license ([#28](https://github.com/sripwoud/pi-memsearch/issues/28)) ([cd8fbb1](https://github.com/sripwoud/pi-memsearch/commit/cd8fbb121c97b75b2b5a3595f27af5946c070175))


### Miscellaneous Chores

* cut v1.0.0 and publish to npm via trusted publishing ([#30](https://github.com/sripwoud/pi-memsearch/issues/30)) ([f233f40](https://github.com/sripwoud/pi-memsearch/commit/f233f401a3865b09b121c52a9f5998622f661764))

## [0.2.0-beta](https://github.com/sripwoud/pi-memsearch/compare/v0.1.0...v0.2.0-beta) (2026-08-14)


### Features

* add backend client (queue, search, expand, status tools) ([#16](https://github.com/sripwoud/pi-memsearch/issues/16)) ([c397260](https://github.com/sripwoud/pi-memsearch/commit/c3972609da83972010ea45a4043fd8e85dd34b6c))
* add write path (project scope, daily memory file, memory_write) ([#11](https://github.com/sripwoud/pi-memsearch/issues/11)) ([931cb86](https://github.com/sripwoud/pi-memsearch/commit/931cb8663bf1672b9ca852dba8a12513fe3e2333))
* **bootstrap:** zero-config first run and mid-session install ([#21](https://github.com/sripwoud/pi-memsearch/issues/21)) ([e26c93c](https://github.com/sripwoud/pi-memsearch/commit/e26c93c6e49b0f23f0fc0a0e51698c60fb600c06))
* **capture:** distill settled exchanges into anchored daily entries ([#14](https://github.com/sripwoud/pi-memsearch/issues/14)) ([c52501f](https://github.com/sripwoud/pi-memsearch/commit/c52501f8f5506a619cfd7f647f0a3039357570e1))
* **index:** catch-up, debounced and shutdown-capped index triggers ([#20](https://github.com/sripwoud/pi-memsearch/issues/20)) ([b6045ef](https://github.com/sripwoud/pi-memsearch/commit/b6045efd8ae1d21befb176ea33b5aa32cb0c43f4))
* inject stable memory snapshot into the system prompt ([#13](https://github.com/sripwoud/pi-memsearch/issues/13)) ([b81123f](https://github.com/sripwoud/pi-memsearch/commit/b81123ff7748e718a9fe6c722e342aa899e4e52e))
* **recall:** add recall skill and /recall prompt template ([#19](https://github.com/sripwoud/pi-memsearch/issues/19)) ([b75010a](https://github.com/sripwoud/pi-memsearch/commit/b75010ad92f5a943b0e60c4e8f262a05e7c044c5)), closes [#8](https://github.com/sripwoud/pi-memsearch/issues/8)


### Miscellaneous Chores

* exclude release-please changelog from dprint ([#18](https://github.com/sripwoud/pi-memsearch/issues/18)) ([afaf9d4](https://github.com/sripwoud/pi-memsearch/commit/afaf9d40db0a741c2810eb447e2591d30f01e900))
* **release:** integration suite, peer floors and usage docs ([#22](https://github.com/sripwoud/pi-memsearch/issues/22)) ([88e0709](https://github.com/sripwoud/pi-memsearch/commit/88e07097ff60a07fce49db62452800674e4e7c3d))
