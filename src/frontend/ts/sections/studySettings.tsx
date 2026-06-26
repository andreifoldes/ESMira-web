import { SectionContent } from "../site/SectionContent";
import m, { Vnode } from "mithril";
import { Lang } from "../singletons/Lang";
import { BindObservable, ConstrainedNumberTransformer } from "../components/BindObservable";
import { TitleRow } from "../components/TitleRow";
import { Study } from "../data/study/Study";
import { safeConfirm } from "../constants/methods";
import { FILE_ADMIN } from "../constants/urls";
import { Requests } from "../singletons/Requests";
import { BtnTrash } from "../components/Buttons";
import { DashRow } from "../components/DashRow";
import { DashElement } from "../components/DashElement";
import { StudyMetadata } from "../loader/StudyLoader";
import { SectionData } from "../site/SectionData";

export class Content extends SectionContent {
	private isFrozen: boolean = false
	private hasFallbackUrls: boolean
	private pushInfo: { vapidConfigured: boolean, subscriptions: number } | null = null
	private pushTestResult: string | null = null

	public static preLoad(sectionData: SectionData): Promise<any>[] {
		return [
			Requests.loadJson(`${FILE_ADMIN}?type=IsFrozen&study_id=${sectionData.getStaticInt("id")}`),
			Requests.loadJson(`${FILE_ADMIN}?type=GetOutboundFallbackUrls&study_id=${sectionData.getStaticInt("id") ?? 0}`).catch(() => { return [] }),
			sectionData.getStudyPromise()
		]
	}

	constructor(sectionData: SectionData, [frozen]: boolean[], fallbackUrls: string[]) {
		super(sectionData);
		this.isFrozen = frozen
		this.hasFallbackUrls = fallbackUrls.length != 0
	}

	public title(): string {
		return Lang.get("study_settings")
	}

	private async toggleFreezeStudy(study: Study, e: InputEvent): Promise<void> {
		const sendFrozen = (e.target as HTMLInputElement).checked
		const [loadFrozen]: boolean[] = await this.sectionData.loader.loadJson(`${FILE_ADMIN}?type=FreezeStudy${sendFrozen ? "&frozen" : ""}&study_id=${study.id.get()}`)
		this.isFrozen = loadFrozen
		this.sectionData.loader.info(this.isFrozen ? Lang.get("info_study_frozen") : Lang.get("info_study_unfrozen"))
	}

	private toggleWearableProvider(study: Study, provider: string, enabled: boolean): void {
		const index = study.wearablesProviders.indexOf(provider)
		if (enabled && index == -1)
			study.wearablesProviders.push(provider)
		else if (!enabled && index != -1)
			study.wearablesProviders.remove(index)
	}

	private async deleteStudy(study: Study): Promise<void> {
		if (!safeConfirm(Lang.get("confirm_delete_study", study.title.get())))
			return

		await this.sectionData.loader.showLoader(this.sectionData.siteData.studyLoader.deleteStudy(study))

		this.goTo("admin/allStudies:edit")
	}

	private async loadPushInfo(study: Study): Promise<void> {
		this.pushInfo = await this.sectionData.loader.loadJson(`${FILE_ADMIN}?type=GetPushInfo&study_id=${study.id.get()}`)
		m.redraw()
	}

	private async sendTestPush(study: Study): Promise<void> {
		const r = await this.sectionData.loader.loadJson(`${FILE_ADMIN}?type=SendTestPush&study_id=${study.id.get()}`, "post")
		this.pushTestResult = `${r.succeeded ?? 0} / ${r.queued ?? 0} delivered`
		await this.loadPushInfo(study)
	}

	// Runtime web-push status + "send test" for the study (admin monitoring panel).
	private pushAdminView(study: Study): Vnode<any, any> {
		return <div class="leftPadding verticalPadding">
			<button type="button" onclick={() => this.loadPushInfo(study)}>{Lang.get("web_push_status")}</button>
			{this.pushInfo &&
				<small>&nbsp;{Lang.getWithColon("web_push_subscriptions")} {this.pushInfo.subscriptions}{!this.pushInfo.vapidConfigured ? ` · ${Lang.get("web_push_no_vapid")}` : ""}</small>}
			<br />
			<button type="button" onclick={() => this.sendTestPush(study)}>{Lang.get("send_test_notification")}</button>
			{this.pushTestResult && <small>&nbsp;{this.pushTestResult}</small>}
		</div>
	}

	public getView(): Vnode<any, any> {
		const study = this.getStudyOrThrow()
		const studyMetadata: StudyMetadata | null = this.sectionData.siteData.studyLoader.studyMetadata[study.id.get()]
		const uploadSettings = study.eventUploadSettings
		return <div>
			{DashRow(
				DashElement("stretched", {
					content:
						<div class="center">
							<table class="studyInfoTable"><tbody>
								<tr>
									<td>{Lang.getWithColon("study_version")}</td>
									<td>{`${study.version.get()}.${study.subVersion.get()}`}</td>
								</tr>
								<tr>
									<td>{Lang.getWithColon("created_by")}</td>
									{studyMetadata && <td>{studyMetadata.owner}</td>}
								</tr>
								<tr>
									<td>{Lang.getWithColon("creation_date")}</td>
									{studyMetadata && <td>{new Date(studyMetadata.createdTimestamp * 1000).toLocaleString()}</td>}
								</tr>
								{studyMetadata && studyMetadata.owner != studyMetadata.lastSavedBy && <tr>
									<td>{Lang.getWithColon("last_saved_by")}</td>
									{<td>{studyMetadata.lastSavedBy}</td>}
								</tr>}
								{studyMetadata && studyMetadata.lastSavedAt != studyMetadata.createdTimestamp && <tr>
									<td>{Lang.getWithColon("last_saved_at")}</td>
									{<td>{new Date(studyMetadata.lastSavedAt * 1000).toLocaleString()}</td>}
								</tr>}
							</tbody></table>
						</div>
				}),
				DashElement(null, {
					content:
						<div class="center">
							<span class="middle spacingRight">
								{Lang.getWithColon("study_availability")}
							</span>
							<br />
							<br />
							<label class="middle noDesc">
								<small>{Lang.get('Android')}</small>
								<input type="checkbox" {...BindObservable(study.publishedAndroid)} />
							</label>
							&nbsp;
							<label class="middle noDesc">
								<small>{Lang.get('iOS')}</small>
								<input type="checkbox" {...BindObservable(study.publishedIOS)} />
							</label>
							&nbsp;
							<label class="middle noDesc">
								<small>{Lang.get('Web')}</small>
								<input type="checkbox" {...BindObservable(study.publishedWeb)} />
							</label>
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.sendMessagesAllowed)} />
								<span>{Lang.get('allow_incoming_messages')}</span>
							</label>
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="number" {...BindObservable(study.additionalDaysActive, new ConstrainedNumberTransformer(0, undefined))} />
								<span>{Lang.get('additional_days_active')}</span>
								<small>{Lang.get('additional_days_active_info')}</small>
							</label>
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.legacyScheduling)} />
								<span>{Lang.get('use_legacy_scheduling')}</span>
								<small>{Lang.get('use_legacy_scheduling_info')}</small>
							</label>
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.enableTutorialMode)} />
								<span>{Lang.get('enable_tutorial_mode')}</span>
								<small>{Lang.get('enable_tutorial_mode_info')}</small>
							</label>
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.webPushEnabled)} />
								<span>{Lang.get('enable_web_push')}</span>
								<small>{Lang.get('enable_web_push_info')}</small>
							</label>
							{study.webPushEnabled.get() && this.pushAdminView(study)}
						</div>
				}),
				DashElement("vertical", {
					content:
						<div class="vAlignCenter">
							<label class="noTitle noDesc">
								<input type="checkbox" {...BindObservable(study.wearablesEnabled)} />
								<span>{Lang.get('enable_wearables')}</span>
								<small>{Lang.get('enable_wearables_info')}</small>
							</label>
							{study.wearablesEnabled.get() &&
								<div class="leftPadding verticalPadding">
									<small>{Lang.getWithColon('wearables_providers')}</small>
									{(["fitbit", "withings", "oura"] as const).map((provider) =>
										<label class="noTitle noDesc">
											<input type="checkbox"
												checked={study.wearablesProviders.indexOf(provider) != -1}
												onchange={(e: InputEvent) => this.toggleWearableProvider(study, provider, (e.target as HTMLInputElement).checked)} />
											<span>{Lang.get(provider)}</span>
										</label>
									)}
								</div>
							}
						</div>
				}),
				this.hasFallbackUrls && DashElement(null, {
					content:
						<div>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(study.useFallback)} />
								<span>{Lang.get("study_use_fallback")}</span>
								<small>{Lang.get("study_fallback_info")}</small>
							</label>
						</div>
				}),
				DashElement(null, {
					content:
						<div>
							<label class="noTitle">
								<input type="checkbox" checked={this.isFrozen} onchange={this.toggleFreezeStudy.bind(this, study)} />
								<span>{Lang.get("freeze_study")}</span>
								<small>{Lang.get("desc_freeze_study")}</small>
							</label>
						</div>
				})
			)}






			{TitleRow(Lang.getWithColon("inform_server_about_events"))}
			{DashRow(
				DashElement("stretched", {
					content:
						<div class="vertical hAlignStart">
							<label class="noTitle">
								<input type="checkbox" checked="checked" disabled="disabled" />
								<span>joined</span>
								<small>{Lang.get("desc_joined")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" checked="checked" disabled="disabled" />
								<span>questionnaire</span>
								<small>{Lang.get("desc_questionnaire")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" checked="checked" disabled="disabled" />
								<span>quit</span>
								<small>{Lang.get("desc_quit")}</small>
							</label>


							<label class="noTitle">
								<input type="checkbox" checked="checked" {...BindObservable(uploadSettings.actions_executed)} />
								<span>actions_executed</span>
								<small>{Lang.get("desc_actions_executed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.invitation)} />
								<span>invitation</span>
								<small>{Lang.get("desc_invitation")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.invitation_missed)} />
								<span>invitation_missed</span>
								<small>{Lang.get("desc_invitation_missed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.language_changed)} />
								<span>language_changed</span>
								<small>{Lang.get("desc_language_changed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.message)} />
								<span>message</span>
								<small>{Lang.get("desc_message")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.notification)} />
								<span>notification</span>
								<small>{Lang.get("desc_notification")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.rejoined)} />
								<span>rejoined</span>
								<small>{Lang.get("desc_rejoined")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.reminder)} />
								<span>reminder</span>
								<small>{Lang.get("desc_reminder")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.requested_reward_code)} />
								<span>requested_reward_code</span>
								<small>{Lang.get("desc_requested_reward_code")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" checked="checked" {...BindObservable(uploadSettings.schedule_planned)} />
								<span>schedule_planned</span>
								<small>{Lang.get("desc_schedule_planned")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" checked="checked" {...BindObservable(uploadSettings.schedule_removed)} />
								<span>schedule_removed</span>
								<small>{Lang.get("desc_schedule_removed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.schedule_changed)} />
								<span>schedule_changed</span>
								<small>{Lang.get("desc_schedule_changed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.statistic_viewed)} />
								<span>statistic_viewed</span>
								<small>{Lang.get("desc_statistic_viewed")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.study_message)} />
								<span>study_message</span>
								<small>{Lang.get("desc_study_message")}</small>
							</label>
							<label class="noTitle">
								<input type="checkbox" {...BindObservable(uploadSettings.study_updated)} />
								<span>study_updated</span>
								<small>{Lang.get("desc_study_updated")}</small>
							</label>
						</div>
				}))}

			{TitleRow(Lang.getWithColon("delete_study"))}
			<div class="center">
				{BtnTrash(this.deleteStudy.bind(this, study), Lang.get("delete_study"))}
			</div>
		</div>
	}
}