import {SectionContent} from "../site/SectionContent";
import m, {Vnode} from "mithril";
import {Lang} from "../singletons/Lang";
import {ObservableLangChooser} from "../components/ObservableLangChooser";
import {BindObservable} from "../components/BindObservable";
import {RichText} from "../components/RichText";
import {RegexTextInput} from "../components/RegexTextInput";
import {SectionData} from "../site/SectionData";
// @ts-ignore — trianglify has no bundled type declarations
import trianglify from "trianglify";

// Design-system palette from DESIGN.md (heritage greens + tonal neutrals)
const TRIANGLIFY_PALETTES: Record<string, string[]> = {
	"Emerald (default)": ["#f7f9fc", "#eceef1", "#a5ede0", "#006129", "#00471c"],
	"Teal Mist":         ["#f7f9fc", "#a5ede0", "#3f9e90", "#226e63", "#0d3d35"],
	"Forest Night":      ["#191c1e", "#0d3d35", "#00471c", "#006129", "#a5ede0"],
	"Stone & Sage":      ["#eceef1", "#c8d0cc", "#7aab8a", "#3f6e52", "#1a3628"],
}

export class Content extends SectionContent {
	public static preLoad(sectionData: SectionData): Promise<any>[] {
		return [sectionData.getStudyPromise()]
	}
	public title(): string {
		return Lang.get("study_description")
	}

	private selectedPalette: string = "Emerald (default)"

	private generateTrianglifyArtwork(): void {
		const palette = TRIANGLIFY_PALETTES[this.selectedPalette] ?? TRIANGLIFY_PALETTES["Emerald (default)"]
		const pattern = trianglify({
			width: 800,
			height: 200,
			cellSize: 70,
			variance: 0.8,
			xColors: palette,
			yColors: "match",
			seed: Math.random().toString(36).slice(2),
		})
		// toSVGTree returns a lightweight virtual-DOM node; serialise to string via browser APIs
		const svgNode: SVGElement = pattern.toSVG(document.createElementNS("http://www.w3.org/2000/svg", "svg"))
		svgNode.setAttribute("xmlns", "http://www.w3.org/2000/svg")
		const svgString = new XMLSerializer().serializeToString(svgNode)
		const b64 = btoa(unescape(encodeURIComponent(svgString)))
		this.getStudyOrThrow().studyArtwork.set(`data:image/svg+xml;base64,${b64}`)
		m.redraw()
	}

	private handleArtworkUpload(e: Event): void {
		const input = e.target as HTMLInputElement
		const file = input.files?.[0]
		if (!file) return
		const reader = new FileReader()
		reader.onload = () => {
			this.getStudyOrThrow().studyArtwork.set(reader.result as string)
			m.redraw()
		}
		reader.readAsDataURL(file)
	}

	public getView(): Vnode<any, any> {
		const study = this.getStudyOrThrow()
		return <div>
			<label>
				<small>{Lang.getWithColon("title")}</small>
				<input type="text" {...BindObservable(study.title)} />
				{ObservableLangChooser(study)}
			</label>

			<label>
				<small>{Lang.getWithColon("study_tag")}</small>
				<input type="text" {...BindObservable(study.studyTag)} />
				{ObservableLangChooser(study)}
			</label>

			{
				RegexTextInput(
					Lang.getWithColon("contactEmail"),
					study.contactEmail,
					/^[\w\-.]+@([\w-]+\.)+[\w-]{2,}$/,
					Lang.get("validator_warning_email"))
			}

			<div class="fakeLabel spacingTop line">
				<small>Study artwork ({Lang.get("can_be_left_empty")}):</small>
				{study.studyArtwork.get() &&
					<div style="margin:8px 0;">
						<img
							src={study.studyArtwork.get()}
							alt="Study artwork preview"
							style="width:100%;max-width:400px;height:100px;border-radius:8px;object-fit:cover;display:block;"
						/>
					</div>
				}
				<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;">
					<select
						style="flex:1;min-width:160px;"
						onchange={(e: Event) => {
							this.selectedPalette = (e.target as HTMLSelectElement).value
							m.redraw()
						}}
					>
						{Object.keys(TRIANGLIFY_PALETTES).map(name =>
							<option value={name} selected={name === this.selectedPalette}>{name}</option>
						)}
					</select>
					<button type="button" onclick={this.generateTrianglifyArtwork.bind(this)}>
						Generate artwork
					</button>
					<small style="color:#666;">or</small>
					<input type="file" accept="image/*" onchange={this.handleArtworkUpload.bind(this)} />
					{study.studyArtwork.get() &&
						<button type="button" onclick={() => { study.studyArtwork.set(""); m.redraw() }}>Remove</button>
					}
				</div>
			</div>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("description")}</small>
				{RichText(study.studyDescription)}
				{ObservableLangChooser(study)}
			</div>

			<label class="spacingTop line">
				<small>{Lang.get("informed_consent")} ({Lang.get("can_be_left_empty")}):</small>
				<textarea {...BindObservable(study.informedConsentForm)}></textarea>
				{ObservableLangChooser(this.getStudyOrThrow())}
			</label>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("postInstallInstructions")}</small>
				{RichText(study.postInstallInstructions)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>

			{study.enableTutorialMode.get() &&
				<div class="fakeLabel spacingTop line">
					<h3 class="center">{Lang.get("tutorial")}</h3>
					<label class="line">
						<small>{Lang.getWithColon("tutorial_offer_prompt")} ({Lang.get("can_be_left_empty")})</small>
						<textarea {...BindObservable(study.tutorialOffer)}></textarea>
						{ObservableLangChooser(this.getStudyOrThrow())}
					</label>
					<label class="line spacingTop">
						<small>{Lang.getWithColon("tutorial_intro_text")} ({Lang.get("can_be_left_empty")})</small>
						<textarea {...BindObservable(study.tutorialIntro)}></textarea>
						{ObservableLangChooser(this.getStudyOrThrow())}
					</label>
				</div>
			}

			<div class="fakeLabel spacingTop line">
				<small>{Lang.get("faqs")} ({Lang.get("can_be_left_empty")}):</small>
				{RichText(study.faq)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("webInstallInstructions")}</small>
				{RichText(study.webInstallInstructions)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("chooseUsernameInstructions")}</small>
				{RichText(study.chooseUsernameInstructions)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("webQuestionnaireCompletedInstructions")}</small>
				{RichText(study.webQuestionnaireCompletedInstructions)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>

			<div class="fakeLabel spacingTop line">
				<small>{Lang.getWithColon("post_study_note")}</small>
				{RichText(study.postStudyNote)}
				{ObservableLangChooser(this.getStudyOrThrow())}
			</div>
		</div>
	}
}