/** 설치 템플릿용 배포 진입점. 호스트 서비스는 @eye/workers의 SDK와 Service Binding을 사용한다. */
export { ReportObject } from './runtime/reports.js';
export { SiteControl } from './runtime/site.js';
// TEMP-CODE(issue: #13, remove-when: pre-atomic upgrades unsupported, check: each-release): preserve namespace and pending legacy policy export.
export { ExperimentObject } from './runtime/experiment.js';
export { EyeWorker as default } from './runtime/service.js';
