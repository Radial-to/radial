import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import type {
  CollaborationPlanOptions, CollaborationStateOptions, ConfigInfo, ConflictFile, ConflictResolution, DeploymentDestination, DeploymentObservation, MergeMethod, MergeReceipt,
  PublishEvent, PublishLinkState, PublishOptions, PublishReceipt, PublishTarget, PullRequestDetail, RadialConfig, ReviewAction, ReviewOptions,
  VercelLinkArgs, VercelProjects, VercelProjectsQuery, VercelScope,
} from '../src/shared/radialApi.ts';

// The page is a bare document with the publish scripts and a fake
// window.radial that answers from fixtures the tests change as they go. What
// the page holds, as far as the tests use it:

/** A changed file as git status reports it (some fixtures leave out the index and worktree columns). */
interface FixtureChange { file: string; status: string; index?: string; worktree?: string }
type FixtureConfig = Pick<RadialConfig, 'productionBranch' | 'stagingBranch' | 'productionPublish' | 'productionUrl'>;
/** The receipt the fake publish saves: a PublishReceipt's fields, without its mode, base, from and deployment. */
type FixtureReceipt = Pick<PublishReceipt, 'ok' | 'sha' | 'branch' | 'at' | 'steps' | 'prNumber' | 'prUrl'> & { pushed: true; remote: string; target: PublishTarget | undefined };
/** A merge's receipt as the fake review answers it: no branch or url. */
type FakeMergeReceipt = Omit<MergeReceipt, 'merged' | 'branch' | 'url'>;
/** The first test's repository. */
interface PublishFixture {
  remote: string;
  branch: string;
  changes: FixtureChange[];
  receipt: FixtureReceipt | null;
  behind: number;
  pr: boolean;
  fail: boolean;
  fingerprint: string;
  config: FixtureConfig;
  /** Set while the conflicts step's page.txt is conflicted. */
  conflicted?: boolean;
}
/** How the checkout relates to its upstream (a fake plan's relation). */
interface FakeRelation { ok: true; exists?: true; ahead?: number; behind?: number }
/** The checkout the fakes report. */
interface FakeState extends FakeRelation {
  isRepo: true;
  remote: string;
  slug?: string;
  branch: string;
  head: string;
  changes: FixtureChange[];
  staged?: number;
  conflicts: string[];
  receipt?: FixtureReceipt | null;
}
interface FakePlan {
  ok: true;
  local: FakeState;
  target: PublishTarget | undefined;
  branch: string;
  pr: boolean;
  fingerprint: string;
  relation: FakeRelation;
  hosting: { projectId?: string; orgId?: string };
  deployment: Pick<Extract<DeploymentDestination, { state: 'configured' }>, 'state' | 'production' | 'label'>;
}
/** The pull request the fake review answers with. */
interface FakeReview {
  ok: true;
  pr: Pick<PullRequestDetail['pr'], 'number' | 'state' | 'mergeable' | 'mergeState'> & Partial<Pick<PullRequestDetail['pr'], 'sha' | 'baseSha' | 'base'>>;
  capabilities: { mergeMethods: MergeMethod[] };
  checks: PullRequestDetail['checks'];
  statuses: PullRequestDetail['statuses'];
  checksKnown: boolean;
}
/** collaborationReview's arguments as the publish scripts pass them: each action with its options (list passes none). */
type ReviewArgs = { [A in ReviewAction]: [repoDir: string, action: A, opts?: ReviewOptions[A]] }[ReviewAction];
/** The part of the preload's API the publish scripts call, faked; the second test fakes only the required part. */
interface FakeRadial {
  configGet(repoDir: string): Promise<Pick<ConfigInfo, 'effectiveStaging'> & { isRepo?: boolean; remote: string; config: FixtureConfig }>;
  configSet?(repoDir: string, config: Partial<RadialConfig> | null, remote?: string): Promise<{ ok: true; config: FixtureConfig; remote: string }>;
  publishLinkState(repoDir: string): Promise<Partial<PublishLinkState>>;
  collaborationState(repoDir: string, opts?: CollaborationStateOptions): Promise<FakeState | { ok: false }>;
  collaborationPlan(repoDir: string, opts: CollaborationPlanOptions): Promise<FakePlan>;
  publishDeploy?(repoDir: string, opts: PublishOptions): Promise<FixtureReceipt>;
  collaborationDeployment?(repoDir: string): Promise<{ state: 'unobserved' }>;
  collaborationReview?(...args: ReviewArgs): Promise<FakeReview | FakeMergeReceipt>;
  onPublishEvent?(cb: (event: PublishEvent) => void): void;
  vercelProjectInfo?(repoDir: string): Promise<{ linked: true; project: string }>;
  vercelScopes?(): Promise<{ ok: true; scopes: VercelScope[] }>;
  vercelProjects?(opts: VercelProjectsQuery): Promise<Omit<Extract<VercelProjects, { ok: true }>, 'next'>>;
  vercelLinkExisting?(args: VercelLinkArgs): Promise<{ ok: true }>;
  openExternal?(url: string): void;
  collaborationConflicts?(repoDir: string): Promise<{ ok: true; operation: null; files: Pick<ConflictFile, 'file' | 'mine' | 'incoming' | 'working' | 'fingerprint'>[] }>;
  syncResolve?(repoDir: string, resolution: ConflictResolution): Promise<{ ok: true }>;
}
/** What the fakes record. */
type FakeCall =
  | { kind: 'settings'; config: Partial<RadialConfig> | null; remote?: string }
  | { kind: 'publish'; opts: PublishOptions }
  | { kind: 'hosting'; args: VercelLinkArgs }
  | { kind: 'merge'; opts: ReviewOptions['merge'] }
  | { kind: 'resolve'; opts: ConflictResolution };
/** A plan the second test holds until it finishes it. */
interface PlanRequest { target: PublishTarget | undefined; resolve: (plan: FakePlan) => void; branch: string }
/** A receipt the publish panel hands back (onResult) and keeps (update). */
type PanelReceipt = FixtureReceipt | FakeMergeReceipt;
interface PageGlobals {
  radial: FakeRadial;
  RadialDiffs: { clear(root: HTMLElement): void };
  // The first test.
  fixture: PublishFixture;
  calls: FakeCall[];
  opened: string[];
  finishPublish: () => void;
  publishEvent: (event: PublishEvent) => void;
  // The second test.
  requests: PlanRequest[];
  configReads: number;
  config: FixtureConfig;
  local: FakeState;
  finish: (index: number) => void;
}
declare const window: Window & typeof globalThis & PageGlobals;
declare const radial: FakeRadial;
declare const fixture: PublishFixture;
declare const calls: FakeCall[];
declare const opened: string[];
declare const finishPublish: () => void;
declare const publishEvent: (event: PublishEvent) => void;
declare const requests: PlanRequest[];
declare let configReads: number;
declare const config: FixtureConfig;
declare const local: FakeState;
declare const finish: (index: number) => void;
/** publishWorkflow.js's API. */
declare const RadialPublish: {
  mount(host: HTMLElement, context: { repoDir: string; onResult?: (result: PanelReceipt) => void }): void;
  update(dir: string, patch: { target?: PublishTarget; receipt?: PanelReceipt | null; deployment?: { state: DeploymentObservation['state']; url?: string | null } | null; message?: string }): void;
  refresh(): void;
  open(host: HTMLElement, page: 'conflicts'): void;
};

test('publish in place: direct action, busy guards, receipts, inline settings, and stale configuration', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.setDefaultTimeout(6000);
    await page.route('http://radial.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="publishMenu" class="branch-menu publish-menu" style="display:block;left:20px;top:20px"></div>' }));
    await page.goto('http://radial.test/');
    for (const name of ['styles.css', 'collaboration.css']) await page.addStyleTag({ content: fs.readFileSync('src/renderer/' + name, 'utf8') });
    await page.evaluate(() => {
      window.fixture = { remote: 'https://github.com/team/site', branch: 'main', changes: [{ file: 'index.html', status: ' M', index: ' ', worktree: 'M' }], receipt: null, behind: 0, pr: false, fail: false, fingerprint: 'fp', config: { productionBranch: 'main', stagingBranch: 'staging', productionPublish: 'direct', productionUrl: 'https://example.invalid' } };
      window.calls = []; window.opened = [];
      const state = (): FakeState => ({ ok: true, isRepo: true, exists: true, remote: fixture.remote, slug: 'team/site', branch: fixture.branch, head: fixture.receipt?.sha || 'abc', changes: fixture.changes, ahead: fixture.receipt ? 0 : 2, behind: fixture.behind, staged: 0, conflicts: [], receipt: fixture.receipt });
      window.radial = {
        configGet: async () => ({ isRepo: true, remote: fixture.remote, effectiveStaging: fixture.config.stagingBranch, config: {...fixture.config} }),
        configSet: async (dir, config, remote) => { calls.push({kind:'settings',config,remote}); if (config) Object.assign(fixture.config, config); if(remote) fixture.remote=remote; return {ok:true,config:fixture.config,remote:fixture.remote}; },
        publishLinkState: async () => ({}),
        collaborationState: async (dir, opts={}) => { if(opts.fetch&&fixture.fail) return {ok:false}; return state(); },
        collaborationPlan: async (dir, opts) => ({ok:true,local:state(),target:opts.target,branch:opts.target==='staging'?fixture.config.stagingBranch:fixture.config.productionBranch,pr:fixture.config.productionPublish==='pr',fingerprint:fixture.fingerprint,relation:state(),hosting:{projectId:'project',orgId:'team'},deployment:{state:'configured',production:true,label:'Vercel deploys production.'}}),
        publishDeploy: (dir, opts) => { calls.push({kind:'publish',opts}); return new Promise(resolve=>window.finishPublish=()=> { fixture.changes=[]; fixture.receipt={ok:true,pushed:true,remote:fixture.remote,sha:'def',target:opts.target,branch:'main',at:Date.now(),steps:['committed edits'],...(opts.pr?{prNumber:18,prUrl:'https://github.com/team/site/pull/18'}:{})};resolve(fixture.receipt); }); },
        collaborationDeployment: async () => ({state:'unobserved'}),
        collaborationReview: async () => ({ok:true,pr:{number:18,state:'open',mergeable:true,mergeState:'blocked'},capabilities:{mergeMethods:['squash']},checks:[],statuses:[],checksKnown:true}),
        onPublishEvent: cb => window.publishEvent=cb,
        vercelProjectInfo: async () => ({linked:true,project:'marketing-site'}),
        vercelScopes: async () => ({ok:true,scopes:[{type:'team',slug:'client',name:'Client'}]}),
        vercelProjects: async () => ({ok:true,projects:[{id:'new-project',name:'client-site',orgId:'team_client'}]}),
        vercelLinkExisting: async args => { calls.push({kind:'hosting',args});return {ok:true}; },
        openExternal: url => opened.push(url),
      };
      window.RadialDiffs={clear:()=>{}};
    });
    for (const file of ['publishSettings.js','publishWorkflow.js','collaboration.js']) await page.addScriptTag({ content: fs.readFileSync('out/renderer/'+file,'utf8') });
    await page.evaluate(()=>{RadialPublish.update('/site',{target:'production'});RadialPublish.mount(document.querySelector<HTMLElement>('#publishMenu')!,{repoDir:'/site',onResult:r=>RadialPublish.update('/site',{receipt:r,deployment:null,message:''})});});
    const menu=page.locator('#publishMenu'), action=menu.locator('#pmPublish'), disclosure=menu.locator('summary.pm-disclosure');
    await menu.getByRole('button',{name:'Publish to production',exact:true}).waitFor();
    assert.equal(await menu.evaluate((e: HTMLElement)=>e.offsetWidth),260);
    assert.ok(await menu.evaluate((e: HTMLElement)=>e.offsetHeight)<=310);
    await menu.screenshot({path:'/tmp/radial-unified-ready.png'});
    await action.click();
    assert.equal(await page.locator('dialog').count(),0);
    assert.equal(await menu.getByRole('checkbox',{name:'Production',exact:true}).isDisabled(),true);
    await page.evaluate(()=>publishEvent({repoDir:'/site',kind:'status',text:'Checking saved commit…'}));
    await menu.getByText('Checking saved commit…',{exact:true}).waitFor();
    await page.evaluate(()=>publishEvent({repoDir:'/site',kind:'build_log',text:'Build in progress'}));
    await menu.locator('.pm-workflow > .pm-live-log').getByText('Build output',{exact:true}).click();
    await menu.locator('.pm-workflow > .pm-live-log').getByText('Build in progress',{exact:true}).waitFor();
    await page.evaluate(()=>finishPublish());
    await page.waitForFunction(()=>document.querySelector('.pm-history')!.textContent.includes('Pushed'));
    assert.equal(await menu.locator('.pm-history').textContent().then(t=>t!.includes('Published')),false);
    const publish=await page.evaluate(()=>calls.find(c=>c.kind==='publish')!);
    assert.equal(publish.opts.expectedFingerprint,'fp'); assert.equal(publish.opts.expectedHead,'abc'); assert.equal(publish.opts.expectedPr,false);
    assert.deepEqual(publish.opts.expectedDeployment,{state:'configured',production:true,projectId:'project',orgId:'team'});
    const receiptDetails = menu.locator('.pm-publish-details');
    await menu.getByRole('button', {name:'View publish details',exact:true}).click();
    await receiptDetails.getByText('Pushed def · main', {exact:true}).waitFor();
    assert.equal(await menu.evaluate((el: HTMLElement)=>el.offsetWidth),260,'receipt stays in the compact dropdown');
    assert.equal(await menu.locator('.collab-nav').count(),0,'receipt does not open Git review navigation');
    assert.equal(await menu.getByRole('checkbox',{name:'Production',exact:true}).isEnabled(),true);
    assert.equal(await action.isVisible(),true,'publish action stays in the same place');
    await receiptDetails.getByText('Build output',{exact:true}).click();
    await receiptDetails.getByText('Build in progress',{exact:true}).waitFor();
    await menu.screenshot({path:'/tmp/radial-inline-publish-receipt.png'});
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='publish').length),1,'opening a receipt never publishes');
    await menu.getByRole('button',{name:'Hide publish details',exact:true}).click();
    await page.evaluate(()=>RadialPublish.update('/site',{deployment:{state:'ready',url:'https://deployed.example.invalid'}}));
    await menu.getByRole('button',{name:'Open production',exact:true}).click();
    assert.equal(await page.evaluate(()=>opened.at(-1)),'https://deployed.example.invalid');

    await menu.getByRole('button',{name:'Publish settings',exact:true}).click();
    const staging=menu.getByRole('textbox',{name:'Staging branch',exact:true});await staging.fill('preview');
    await page.evaluate(()=>RadialPublish.refresh());assert.equal(await staging.inputValue(),'preview');
    assert.equal(await staging.evaluate(e=>document.activeElement===e),true);
    await menu.screenshot({path:'/tmp/radial-unified-settings.png'});
    await menu.getByRole('button',{name:'Save settings',exact:true}).click();
    await staging.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>fixture.config.stagingBranch),'preview');
    await disclosure.click(); await menu.getByRole('button',{name:'Edit',exact:true}).click();
    await menu.getByRole('textbox',{name:'Repository URL',exact:true}).fill('client/site');
    await menu.getByRole('button',{name:'Save repository',exact:true}).click();
    await menu.getByRole('textbox',{name:'Repository URL',exact:true}).waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>fixture.remote),'https://github.com/client/site.git');
    assert.equal(await menu.locator('.pm-history').textContent(),'Publish');
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='publish').length),1);

    await menu.getByRole('button',{name:'Publish settings',exact:true}).click();
    await menu.getByRole('button',{name:'Change',exact:true}).click();
    await menu.getByText('client-site',{exact:true}).click();
    await menu.getByRole('button',{name:'Use this project',exact:true}).click();
    await menu.getByRole('textbox',{name:'Staging branch',exact:true}).waitFor();
    await menu.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>calls.find(c=>c.kind==='hosting')!.args.projectId),'new-project');

    await page.evaluate(()=>{fixture.fail=true;});
    if(!await disclosure.evaluate((e: HTMLElement)=>(e.parentElement as HTMLDetailsElement).open))await disclosure.click();
    await menu.getByRole('button',{name:'Fetch',exact:true}).click();
    await menu.getByText('Couldn’t fetch updates. Try again.',{exact:true}).waitFor();
    await disclosure.click();assert.equal(await menu.locator('.pm-fetch-error').isVisible(),true);
    await page.evaluate(()=>{fixture.fail=false;fixture.behind=1;});
    await menu.getByRole('button',{name:'Refresh checks',exact:true}).click();
    await menu.getByRole('button',{name:'Update from main',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='publish').length),1);
    await page.evaluate(()=>{fixture.behind=0;fixture.config.productionPublish='pr';fixture.changes=[{file:'index.html',status:' M'}];RadialPublish.refresh();});
    await menu.getByRole('button',{name:'Open pull request',exact:true}).waitFor();
    await menu.getByRole('textbox',{name:'Pull request title',exact:true}).fill('Update homepage');
    await action.click();await page.evaluate(()=>finishPublish());
    await menu.getByRole('button',{name:'Review pull request #18',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='publish').at(-1)!.opts.pr),true);
    assert.equal(await menu.locator('.pm-history').textContent().then(t=>t!.includes('Published')),false);
    assert.equal(await page.locator('dialog').count(),0);
    await page.evaluate(()=>{
      radial.collaborationReview=async (dir, action, opts?)=>{
        if(action==='merge'){ calls.push({kind:'merge',opts:opts!});return {ok:true,pushed:true,mode:'merge',sha:'merged',remote:fixture.remote,prNumber:18,at:Date.now()}; }
        return {ok:true,pr:{number:18,state:'open',mergeable:true,mergeState:'clean',sha:'reviewed-sha',baseSha:'reviewed-base',base:'main'},capabilities:{mergeMethods:['squash']},checks:[],statuses:[],checksKnown:true};
      };
      RadialPublish.mount(document.querySelector<HTMLElement>('#publishMenu')!,{repoDir:'/merge',onResult:r=>RadialPublish.update('/merge',{receipt:r,deployment:null})});
      RadialPublish.update('/merge',{target:'production'});RadialPublish.refresh();
    });
    await menu.getByRole('button',{name:'Merge and deploy production',exact:true}).click();
    await page.waitForFunction(()=>calls.some(c=>c.kind==='merge'));
    const merged=await page.evaluate(()=>calls.find(c=>c.kind==='merge')!.opts);
    assert.equal(merged.sha,'reviewed-sha');assert.equal(merged.baseSha,'reviewed-base');assert.equal(merged.method,'squash');
    assert.equal(merged.expectedRemote,'https://github.com/client/site.git');assert.equal(merged.expectedDeployment!.production,true);
    await page.waitForFunction(()=>document.querySelector('.pm-history')!.textContent.includes('Pushed'));

    await page.evaluate(()=>{
      fixture.conflicted=true;
      radial.collaborationConflicts=async()=>({ok:true,operation:null,files:fixture.conflicted?[{file:'page.txt',mine:'local',incoming:'remote',working:'Shared intro\n<<<<<<< HEAD\nMy title\n=======\nTheir title\n>>>>>>> remote\nIncoming footer\n',fingerprint:'conflict-snapshot'}]:[]});
      radial.syncResolve=async(dir,opts)=>{calls.push({kind:'resolve',opts});fixture.conflicted=false;return {ok:true};};
      RadialPublish.open(document.querySelector<HTMLElement>('#publishMenu')!,'conflicts');
    });
    await menu.getByRole('button',{name:'Use your text',exact:true}).click();
    assert.equal(await menu.getByRole('textbox',{name:'Resolved file contents'}).inputValue(),'Shared intro\nMy title\nIncoming footer\n');
    await menu.getByRole('button',{name:'Save this resolution',exact:true}).click();
    await page.waitForFunction(()=>calls.some(c=>c.kind==='resolve'));
    assert.equal(await page.evaluate(()=>calls.find(c=>c.kind==='resolve')!.opts.expectedFingerprint),'conflict-snapshot');
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.kind==='publish').length),2);
  } finally {await browser.close();}
});

test('destination switches reuse separate checks instantly and ignore late results for other targets', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(6000);
    await page.route('http://radial.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="publishMenu"></div>' }));
    await page.goto('http://radial.test/');
    await page.evaluate(() => {
      window.requests = []; window.configReads = 0;
      window.config = { productionBranch: 'main', stagingBranch: 'staging', productionPublish: 'direct' };
      window.local = { ok: true, isRepo: true, branch: 'main', head: 'abc', remote: 'https://github.com/client/site', changes: [{file:'index.html',status:' M'}], conflicts: [] };
      window.radial = {
        configGet: async () => { configReads++; return { remote: local.remote, effectiveStaging: config.stagingBranch, config: {...config} }; },
        collaborationState: async () => ({...local}), publishLinkState: async () => ({}),
        collaborationPlan: (dir, {target}) => new Promise(resolve => requests.push({ target, resolve, branch: target === 'production' ? config.productionBranch : config.stagingBranch })),
      };
      window.finish = (index) => {
        const req = requests[index], production = req.target === 'production';
        req.resolve({ ok:true,target:req.target,branch:req.branch,local:{...local},fingerprint:'fingerprint',pr:production,hosting:{},deployment:{state:'configured',production,label:'Deployment configured.'},relation:{ok:true,exists:true,ahead:0,behind:production?3:0} });
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('out/renderer/publishWorkflow.js','utf8') });
    await page.evaluate(() => RadialPublish.mount(document.querySelector<HTMLElement>('#publishMenu')!,{repoDir:'/site'}));
    await page.waitForFunction(() => requests.length === 2);
    await page.evaluate(() => finish(0));
    await page.waitForFunction(() => document.querySelector('#pmPublish')!.textContent === 'Publish to staging');
    const state = () => page.evaluate(() => ({ text:document.querySelector('#pmPublish')!.textContent,disabled:document.querySelector<HTMLButtonElement>('#pmPublish')!.disabled,behind:!document.querySelector<HTMLButtonElement>('.pm-incoming-alert')!.hidden,requests:requests.length }));
    await page.evaluate(() => {
      RadialPublish.update('/site',{target:'production'});
      if (document.querySelector('#pmPublish')!.textContent !== 'Publish to production') throw Error('Destination label did not update synchronously');
      if (!document.querySelector<HTMLButtonElement>('#pmPublish')!.disabled) throw Error('Unchecked destination must not publish');
      RadialPublish.update('/site',{target:'staging'});
    });
    assert.deepEqual(await state(), {text:'Publish to staging',disabled:false,behind:false,requests:2});
    await page.evaluate(() => finish(1));
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.deepEqual(await state(), {text:'Publish to staging',disabled:false,behind:false,requests:2});
    await page.evaluate(() => {
      RadialPublish.update('/site',{target:'production'});
      if (document.querySelector('#pmPublish')!.textContent !== 'Open pull request') throw Error('Cached production action was not immediate');
    });
    assert.deepEqual(await state(), {text:'Open pull request',disabled:false,behind:true,requests:2});
    await page.evaluate(() => RadialPublish.update('/site',{target:'staging'}));
    assert.deepEqual(await state(), {text:'Publish to staging',disabled:false,behind:false,requests:2});
    assert.equal(await page.evaluate(() => configReads),1,'switching does not refetch shared configuration');

    await page.evaluate(() => { config.productionBranch='release'; RadialPublish.refresh(); });
    await page.waitForFunction(() => requests.length === 4);
    await page.evaluate(() => RadialPublish.update('/site',{target:'production'}));
    assert.equal((await state()).disabled,true,'changed settings invalidate cached destination checks');
    await page.evaluate(() => { config.productionBranch='release-v2'; RadialPublish.refresh(); });
    await page.waitForFunction(() => requests.length === 6);
    await page.evaluate(() => { finish(2); finish(3); });
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal((await state()).disabled,true,'late checks for previous settings cannot enable publishing');
    await page.evaluate(() => { finish(4); finish(5); });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#pmPublish')!.disabled);
    assert.equal(await page.locator('[data-branch="production"]').textContent(),'origin/release-v2');
    await page.evaluate(() => { local.changes=[{file:'index.html',status:' M'},{file:'about.html',status:'??'}]; RadialPublish.refresh(); });
    await page.waitForFunction(() => requests.length === 8);
    await page.evaluate(() => { local.changes=[...local.changes,{file:'contact.html',status:'??'}]; finish(6); });
    await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(resolve)));
    assert.equal(await page.locator('.pm-change-count').textContent(),'3 changed files','the ready action shows the file snapshot that was checked');

  } finally { await browser.close(); }
});
