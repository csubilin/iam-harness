"""Read, check, repair and import exploration drilling workbooks into Mining, and
export a project's drilling resources back to the same four-sheet workbook.

Storage mapping (the platform's existing resources; no schema change):

  * one ``IamElement`` per hole, a child of one exploration element;
  * one ``Polyline3d`` per hole: vertex 0 is the collar, the other vertices are
    survey stations, with OnVertex columns for depth/azimuth/dip;
  * one ``LineSet`` per hole and interval kind (samples, lithology): one segment
    per interval, with OnPart columns for from/to and OnGeometry for the kind;
  * mineral elements are ordinary Number fields.  ``TFe``, ``Cu``, ... are all
    ``component.<header>`` columns on the sample line set, so an extra workbook
    column needs no schema or code change.

The workbook is read as-is.  ``check_exploration_data`` reports what is wrong
without changing anything; ``repair_exploration_data`` applies only the repairs
the caller names and records every change; ``import_exploration_data`` refuses
to publish when an unfixed error would make the stored data contradict itself.

Defaults are deliberately explicit: TFe is assumed to be percent (the workbook
does not say), the survey's last direction is extrapolated to the hole's total
depth with the length recorded, and no repair runs unless asked for.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from . import _abi
from ._abi import IamError
from .port import Port

# The four tables of the workbook this importer was written for.
COLLAR = "collar"
SURVEY = "survey"
SAMPLE = "sample"
LITHOLOGY = "lithology"
SHEETS = (COLLAR, SURVEY, SAMPLE, LITHOLOGY)
DEFAULT_SHEETS = {
    COLLAR: "孔口表",
    SURVEY: "测斜表",
    SAMPLE: "样品表",
    LITHOLOGY: "岩性表",
}
DEFAULT_UNITS = {"TFe": "%"}

# Repairs that change no value: whitespace, exact duplicate rows, and an
# azimuth that is merely expressed outside [0, 360).  Everything else can
# change a depth or an interval and is therefore NOT in the default set.
SAFE_REPAIRS = ("trim", "drop_duplicate_rows", "normalize_azimuth")
OPTIONAL_REPAIRS = ("swap_reversed", "clip_to_total_depth",
                    "trim_lithology_overlaps", "extend_total_depth")
ALL_REPAIRS = SAFE_REPAIRS + OPTIONAL_REPAIRS

MAX_EXTRAPOLATION_DEFAULT = 50.0
MAX_SAMPLE_LENGTH_DEFAULT = 10.0
MAX_DOGLEG_DEFAULT = 30.0

_NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
_M = "{%s}" % _NS["m"]
_R = "{%s}" % _NS["r"]


class ExplorationDataError(RuntimeError):
    """The workbook cannot be read as the four-table exploration layout."""


@dataclass
class Collar:
    hole: str
    east: float | None
    north: float | None
    elevation: float | None
    total_depth: float | None
    line: str | None
    engineering_type: str | None
    row: int


@dataclass
class SurveyRow:
    hole: str
    depth: float | None
    azimuth: float | None
    dip: float | None
    row: int


@dataclass
class SampleRow:
    hole: str
    number: str
    from_depth: float | None
    to_depth: float | None
    length: float | None
    components: dict[str, float | None]
    row: int


@dataclass
class LithologyRow:
    hole: str
    from_depth: float | None
    to_depth: float | None
    rock: str
    row: int


@dataclass
class Finding:
    severity: str  # "error" | "warning" | "info"
    code: str
    message: str
    sheet: str | None = None
    row: int | None = None
    rows: list[int] | None = None
    hole: str | None = None
    field: str | None = None
    fixable: bool = False

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"severity": self.severity, "code": self.code,
                                 "message": self.message}
        for name in ("sheet", "row", "rows", "hole", "field"):
            item = getattr(self, name)
            if item not in (None, []):
                value[name] = item
        if self.fixable:
            value["fixable"] = True
        return value


@dataclass
class Repair:
    code: str
    sheet: str
    row: int | None
    hole: str | None
    field: str | None
    before: Any
    after: Any
    message: str

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"code": self.code, "sheet": self.sheet,
                                 "message": self.message}
        if self.row is not None:
            value["row"] = self.row
        if self.hole:
            value["hole"] = self.hole
        if self.field:
            value["field"] = self.field
        value["before"] = self.before
        value["after"] = self.after
        return value


@dataclass
class ExplorationData:
    collars: list[Collar] = field(default_factory=list)
    surveys: list[SurveyRow] = field(default_factory=list)
    samples: list[SampleRow] = field(default_factory=list)
    lithologies: list[LithologyRow] = field(default_factory=list)
    components: list[str] = field(default_factory=list)
    source: str = ""
    sheets: dict[str, str] = field(default_factory=dict)
    read_findings: list[Finding] = field(default_factory=list)


@dataclass
class ImportResult:
    ok: bool
    source: Path
    output: Path | None
    project_id: str
    revision: int | None
    counts: dict[str, Any]
    findings: list[Finding]
    repairs: list[Repair]
    reports: dict[str, Path]
    statistics: dict[str, Any] = field(default_factory=dict)
    port: Port | None = field(default=None, repr=False)
    error: str | None = None


# ---------------------------------------------------------------------------
# Reading


def _ref(ref: str) -> tuple[int, int]:
    match = re.match(r"([A-Z]+)(\d+)", ref)
    if not match:
        raise ExplorationDataError("工作簿含有无法识别的单元格地址: %s" % ref)
    column = 0
    for character in match.group(1):
        column = column * 26 + (ord(character) - 64)
    return column - 1, int(match.group(2))


def _read_sheets(path: Path) -> dict[str, list[tuple[int, list[str]]]]:
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise ExplorationDataError("无法打开 .xlsx 文件: %s" % error) from error
    with archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", _NS):
                shared.append("".join(node.text or "" for node in item.iter(_M + "t")))
        try:
            workbook = ET.fromstring(archive.read("xl/workbook.xml"))
            relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        except KeyError as error:
            raise ExplorationDataError("工作簿缺少 workbook.xml: %s" % error) from error
        targets = {relation.get("Id"): relation.get("Target") for relation in relations}
        result: dict[str, list[tuple[int, list[str]]]] = {}
        sheets_element = workbook.find("m:sheets", _NS)
        for sheet in (sheets_element if sheets_element is not None else []):
            name = sheet.get("name") or ""
            target = targets.get(sheet.get(_R + "id"))
            if not target:
                continue
            target = target.lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            try:
                root = ET.fromstring(archive.read(target))
            except KeyError:
                continue
            rows: list[tuple[int, list[str]]] = []
            for row in root.iter(_M + "row"):
                cells: dict[int, str] = {}
                for cell in row.findall("m:c", _NS):
                    reference = cell.get("r")
                    if not reference:
                        continue
                    column, _ = _ref(reference)
                    kind = cell.get("t")
                    value = cell.find("m:v", _NS)
                    inline = cell.find("m:is", _NS)
                    if kind == "s" and value is not None and value.text is not None:
                        try:
                            text = shared[int(value.text)]
                        except (ValueError, IndexError):
                            text = ""
                    elif kind == "inlineStr" and inline is not None:
                        text = "".join(node.text or "" for node in inline.iter(_M + "t"))
                    elif value is not None and value.text is not None:
                        text = value.text
                    else:
                        text = ""
                    cells[column] = text
                if cells:
                    width = max(cells) + 1
                    rows.append((int(row.get("r") or len(rows) + 1),
                                 [cells.get(index, "") for index in range(width)]))
            result[name] = rows
        return result


def _text(value: str | None) -> str:
    return (value or "").strip()


def _number(value: str | None, findings: list[Finding], sheet: str, row: int,
            name: str) -> float | None:
    text = _text(value)
    if not text:
        return None
    try:
        result = float(text)
    except ValueError:
        findings.append(Finding("error", "cell.non_numeric",
                                "%s 不是数值: %r" % (name, text), sheet=sheet, row=row,
                                field=name))
        return None
    if not math.isfinite(result):
        findings.append(Finding("error", "cell.non_finite",
                                "%s 不是有限数值: %r" % (name, text), sheet=sheet, row=row,
                                field=name))
        return None
    return result


def _column_index(header: Sequence[str], required: Sequence[str], sheet: str,
                  findings: list[Finding]) -> dict[str, int]:
    index: dict[str, int] = {}
    for position, value in enumerate(header):
        name = _text(value)
        if not name:
            continue
        if name in index:
            findings.append(Finding("error", "header.duplicate",
                                    "表头 '%s' 出现了不止一次" % name, sheet=sheet,
                                    field=name))
            continue
        index[name] = position
    missing = [name for name in required if name not in index]
    if missing:
        raise ExplorationDataError("工作表 '%s' 缺少必需列: %s" % (sheet, "、".join(missing)))
    return index


def _sheet_rows(sheets: dict[str, list[tuple[int, list[str]]]], name: str) -> list[tuple[int, list[str]]]:
    if name not in sheets:
        raise ExplorationDataError("工作簿缺少工作表 '%s'" % name)
    rows = sheets[name]
    if not rows:
        raise ExplorationDataError("工作表 '%s' 是空的" % name)
    return rows


def _cell(cells: Sequence[str], index: dict[str, int], name: str) -> str:
    position = index[name]
    return cells[position] if position < len(cells) else ""


def read_exploration_workbook(path: str | Path, *, sheets: dict[str, str] | None = None,
                              component_columns: Sequence[str] | None = None) -> ExplorationData:
    """Reads the four-table workbook without changing a value.

    ``sheets`` maps the logical names (collar, survey, sample, lithology) to the
    workbook's sheet names.  ``component_columns`` names the mineral-element
    columns explicitly; when omitted every non-empty header after 样长 is one,
    which is the sample sheet's own layout.
    """
    source = Path(path)
    sheet_names = dict(DEFAULT_SHEETS)
    if sheets:
        sheet_names.update(sheets)
    raw = _read_sheets(source)
    data = ExplorationData(source=str(source), sheets=sheet_names)
    findings = data.read_findings

    collar_rows = _sheet_rows(raw, sheet_names[COLLAR])
    collar_header_row, collar_header = collar_rows[0]
    collar_index = _column_index(collar_header,
                                 ("钻孔名称", "东坐标", "北坐标", "高程", "总深度", "勘探线号"),
                                 sheet_names[COLLAR], findings)
    for row_number, cells in collar_rows[1:]:
        if not any(_text(value) for value in cells):
            continue
        data.collars.append(Collar(
            hole=_text(_cell(cells, collar_index, "钻孔名称")),
            east=_number(_cell(cells, collar_index, "东坐标"), findings,
                         sheet_names[COLLAR], row_number, "东坐标"),
            north=_number(_cell(cells, collar_index, "北坐标"), findings,
                          sheet_names[COLLAR], row_number, "北坐标"),
            elevation=_number(_cell(cells, collar_index, "高程"), findings,
                              sheet_names[COLLAR], row_number, "高程"),
            total_depth=_number(_cell(cells, collar_index, "总深度"), findings,
                                sheet_names[COLLAR], row_number, "总深度"),
            line=_text(_cell(cells, collar_index, "勘探线号")) or None,
            engineering_type=(_text(_cell(cells, collar_index, "工程类型"))
                              if "工程类型" in collar_index else "") or None,
            row=row_number))

    survey_rows = _sheet_rows(raw, sheet_names[SURVEY])
    _, survey_header = survey_rows[0]
    survey_index = _column_index(survey_header, ("钻孔名称", "测斜深度", "方位角", "倾角"),
                                 sheet_names[SURVEY], findings)
    for row_number, cells in survey_rows[1:]:
        if not any(_text(value) for value in cells):
            continue
        data.surveys.append(SurveyRow(
            hole=_text(_cell(cells, survey_index, "钻孔名称")),
            depth=_number(_cell(cells, survey_index, "测斜深度"), findings,
                          sheet_names[SURVEY], row_number, "测斜深度"),
            azimuth=_number(_cell(cells, survey_index, "方位角"), findings,
                            sheet_names[SURVEY], row_number, "方位角"),
            dip=_number(_cell(cells, survey_index, "倾角"), findings,
                        sheet_names[SURVEY], row_number, "倾角"),
            row=row_number))

    sample_rows = _sheet_rows(raw, sheet_names[SAMPLE])
    _, sample_header = sample_rows[0]
    sample_index = _column_index(sample_header, ("钻孔名称", "样号", "从", "至", "样长"),
                                 sheet_names[SAMPLE], findings)
    if component_columns is None:
        components = []
        first = sample_index["样长"] + 1
        for position in range(first, len(sample_header)):
            name = _text(sample_header[position])
            if name and name not in components:
                components.append(name)
        if len(components) != len(set(components)):
            findings.append(Finding("error", "component.duplicate",
                                    "样品表的矿物元素列有重名", sheet=sheet_names[SAMPLE],
                                    field="矿物元素"))
    else:
        components = list(component_columns)
        for name in components:
            if name not in sample_index and name not in [_text(value) for value in sample_header]:
                raise ExplorationDataError("样品表没有矿物元素列 '%s'" % name)
    data.components = components
    for row_number, cells in sample_rows[1:]:
        if not any(_text(value) for value in cells):
            continue
        values: dict[str, float | None] = {}
        for name in components:
            position = _header_position(sample_header, name)
            if position is None:
                values[name] = None
                continue
            values[name] = _number(cells[position] if position < len(cells) else "",
                                   findings, sheet_names[SAMPLE], row_number, name)
        data.samples.append(SampleRow(
            hole=_text(_cell(cells, sample_index, "钻孔名称")),
            number=_text(_cell(cells, sample_index, "样号")),
            from_depth=_number(_cell(cells, sample_index, "从"), findings,
                               sheet_names[SAMPLE], row_number, "从"),
            to_depth=_number(_cell(cells, sample_index, "至"), findings,
                             sheet_names[SAMPLE], row_number, "至"),
            length=_number(_cell(cells, sample_index, "样长"), findings,
                           sheet_names[SAMPLE], row_number, "样长"),
            components=values, row=row_number))

    lithology_rows = _sheet_rows(raw, sheet_names[LITHOLOGY])
    _, lithology_header = lithology_rows[0]
    lithology_index = _column_index(lithology_header, ("钻孔名称", "从", "至", "岩性"),
                                    sheet_names[LITHOLOGY], findings)
    for row_number, cells in lithology_rows[1:]:
        if not any(_text(value) for value in cells):
            continue
        data.lithologies.append(LithologyRow(
            hole=_text(_cell(cells, lithology_index, "钻孔名称")),
            from_depth=_number(_cell(cells, lithology_index, "从"), findings,
                               sheet_names[LITHOLOGY], row_number, "从"),
            to_depth=_number(_cell(cells, lithology_index, "至"), findings,
                             sheet_names[LITHOLOGY], row_number, "至"),
            rock=_text(_cell(cells, lithology_index, "岩性")),
            row=row_number))
    return data


def _header_position(header: Sequence[str], name: str) -> int | None:
    for position, value in enumerate(header):
        if _text(value) == name:
            return position
    return None


# ---------------------------------------------------------------------------
# Checking


def _collars_by_hole(data: ExplorationData) -> tuple[dict[str, Collar], dict[str, list[Collar]]]:
    by_hole: dict[str, Collar] = {}
    duplicates: dict[str, list[Collar]] = defaultdict(list)
    for collar in data.collars:
        if not collar.hole:
            continue
        if collar.hole in by_hole:
            duplicates[collar.hole].append(collar)
        else:
            by_hole[collar.hole] = collar
    return by_hole, duplicates


def _surveys_by_hole(data: ExplorationData) -> dict[str, list[SurveyRow]]:
    result: dict[str, list[SurveyRow]] = defaultdict(list)
    for row in data.surveys:
        result[row.hole].append(row)
    return result


def _samples_by_hole(data: ExplorationData) -> dict[str, list[SampleRow]]:
    result: dict[str, list[SampleRow]] = defaultdict(list)
    for row in data.samples:
        result[row.hole].append(row)
    return result


def _lithologies_by_hole(data: ExplorationData) -> dict[str, list[LithologyRow]]:
    result: dict[str, list[LithologyRow]] = defaultdict(list)
    for row in data.lithologies:
        result[row.hole].append(row)
    return result


def _direction(azimuth: float, dip: float) -> tuple[float, float, float]:
    a, d = math.radians(azimuth), math.radians(dip)
    return (math.cos(d) * math.sin(a), math.cos(d) * math.cos(a), math.sin(d))


def _dogleg(first: SurveyRow, second: SurveyRow) -> float:
    if None in (first.azimuth, first.dip, second.azimuth, second.dip):
        return 0.0
    a = _direction(first.azimuth, first.dip)
    b = _direction(second.azimuth, second.dip)
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))
    return math.degrees(math.acos(dot))


def _is_integer_text(value: str) -> bool:
    try:
        number = float(value)
    except ValueError:
        return False
    return math.isfinite(number) and number.is_integer()


def check_exploration_data(data: ExplorationData, *, units: dict[str, str] | None = None,
                           extrapolate: str = "last",
                           max_extrapolation: float = MAX_EXTRAPOLATION_DEFAULT,
                           max_sample_length: float = MAX_SAMPLE_LENGTH_DEFAULT,
                           max_dogleg_degrees: float = MAX_DOGLEG_DEFAULT) -> list[Finding]:
    """Returns every qualification finding without changing the data.

    Errors make the project self-contradictory or impossible to place and block
    an import.  Warnings are data-quality concerns that still import unless the
    caller asks for strict.  Info is descriptive.
    """
    findings = list(data.read_findings)
    units = dict(DEFAULT_UNITS) if units is None else dict(units)
    collars, duplicate_collars = _collars_by_hole(data)
    surveys = _surveys_by_hole(data)
    samples = _samples_by_hole(data)
    lithologies = _lithologies_by_hole(data)

    for name, rows in duplicate_collars.items():
        findings.append(Finding("error", "collar.duplicate_hole",
                                "孔口表中钻孔 '%s' 出现了 %d 次" % (name, len(rows) + 1),
                                sheet=data.sheets[COLLAR], rows=[rows[0].row] + [row.row for row in rows],
                                hole=name))
    for collar in data.collars:
        if not collar.hole:
            findings.append(Finding("error", "collar.empty_hole", "孔口表有一行没有钻孔名称",
                                    sheet=data.sheets[COLLAR], row=collar.row))
            continue
        for field_name, value in (("东坐标", collar.east), ("北坐标", collar.north),
                                  ("高程", collar.elevation), ("总深度", collar.total_depth)):
            if value is None:
                findings.append(Finding("error", "collar.missing_value",
                                        "%s 的%s 为空或不是数值" % (collar.hole, field_name),
                                        sheet=data.sheets[COLLAR], row=collar.row,
                                        hole=collar.hole, field=field_name))
        if collar.total_depth is not None and not collar.total_depth > 0:
            findings.append(Finding("error", "collar.invalid_total_depth",
                                    "%s 的总深度必须为正数" % collar.hole,
                                    sheet=data.sheets[COLLAR], row=collar.row,
                                    hole=collar.hole, field="总深度"))
        if collar.line and not _is_integer_text(collar.line):
            findings.append(Finding("warning", "collar.line_not_integer",
                                    "%s 的勘探线号 '%s' 不是整数，将按文本字段保存"
                                    % (collar.hole, collar.line),
                                    sheet=data.sheets[COLLAR], row=collar.row,
                                    hole=collar.hole, field="勘探线号"))
        if not collar.engineering_type:
            findings.append(Finding("info", "collar.engineering_type_blank",
                                    "%s 的工程类型为空，将保存为 null" % collar.hole,
                                    sheet=data.sheets[COLLAR], row=collar.row,
                                    hole=collar.hole, field="工程类型",
                                    fixable=False))

    for hole, rows in surveys.items():
        if hole not in collars:
            findings.append(Finding("error", "survey.unknown_hole",
                                    "测斜表引用了孔口表没有的钻孔 '%s'" % hole,
                                    sheet=data.sheets[SURVEY], hole=hole,
                                    rows=[row.row for row in rows]))

    for hole, collar in collars.items():
        rows = surveys.get(hole, [])
        if not rows:
            findings.append(Finding("error", "hole.no_survey",
                                    "%s 没有测斜记录，无法生成轨迹" % hole,
                                    sheet=data.sheets[SURVEY], hole=hole))
            continue
        ordered = sorted(rows, key=lambda row: (row.depth if row.depth is not None else -math.inf,
                                                row.row))
        if [row.row for row in rows] != [row.row for row in ordered]:
            findings.append(Finding("info", "survey.out_of_order",
                                    "%s 的测斜记录未按深度排序，入库时会排序（不改数值）" % hole,
                                    sheet=data.sheets[SURVEY], hole=hole))
        depths: dict[float, list[SurveyRow]] = defaultdict(list)
        for row in rows:
            if row.depth is None or row.azimuth is None or row.dip is None:
                findings.append(Finding("error", "survey.missing_value",
                                        "%s 有一条测斜记录缺少数值" % hole,
                                        sheet=data.sheets[SURVEY], row=row.row, hole=hole))
                continue
            if row.depth < 0:
                findings.append(Finding("error", "survey.depth_negative",
                                        "%s 的测斜深度为负: %s" % (hole, row.depth),
                                        sheet=data.sheets[SURVEY], row=row.row, hole=hole,
                                        field="测斜深度"))
            if collar.total_depth is not None and row.depth > collar.total_depth + 1e-9:
                findings.append(Finding("error", "survey.depth_beyond_total",
                                        "%s 的测斜深度 %s 超过总深度 %s"
                                        % (hole, row.depth, collar.total_depth),
                                        sheet=data.sheets[SURVEY], row=row.row, hole=hole,
                                        field="测斜深度"))
            if not (0 <= row.azimuth < 360):
                findings.append(Finding("error", "survey.azimuth_range",
                                        "%s 的方位角 %s 不在 [0, 360) 内"
                                        % (hole, row.azimuth),
                                        sheet=data.sheets[SURVEY], row=row.row, hole=hole,
                                        field="方位角", fixable=True))
            if not (-90 <= row.dip <= 90):
                findings.append(Finding("error", "survey.dip_range",
                                        "%s 的倾角 %s 不在 [-90, 90] 内" % (hole, row.dip),
                                        sheet=data.sheets[SURVEY], row=row.row, hole=hole,
                                        field="倾角"))
            depths[round(row.depth, 9)].append(row)
        for depth, group in depths.items():
            if len(group) > 1:
                same = len({(row.azimuth, row.dip) for row in group}) == 1
                findings.append(Finding(
                    "error", "survey.duplicate_depth",
                    "%s 在深度 %s 处有 %d 条%s测斜记录"
                    % (hole, depth, len(group), "相同" if same else "不同"),
                    sheet=data.sheets[SURVEY], rows=[row.row for row in group], hole=hole,
                    field="测斜深度", fixable=same))
        for index in range(1, len(ordered)):
            first, second = ordered[index - 1], ordered[index]
            if first.depth is None or second.depth is None:
                continue
            angle = _dogleg(first, second)
            if angle > max_dogleg_degrees:
                findings.append(Finding("warning", "survey.dogleg",
                                        "%s 在 %s m 与 %s m 之间狗腿角 %.2f°，超过 %.0f°"
                                        % (hole, first.depth, second.depth, angle,
                                           max_dogleg_degrees),
                                        sheet=data.sheets[SURVEY],
                                        rows=[first.row, second.row], hole=hole))
            if (first.azimuth is not None and second.azimuth is not None and
                    abs(((second.azimuth - first.azimuth + 540) % 360) - 180) > 90):
                findings.append(Finding("warning", "survey.azimuth_reversal",
                                        "%s 在 %s m 与 %s m 之间方位角反向（%.2f° → %.2f°）；"
                                        "近垂直孔可能因此无几何影响"
                                        % (hole, first.depth, second.depth, first.azimuth,
                                           second.azimuth),
                                        sheet=data.sheets[SURVEY],
                                        rows=[first.row, second.row], hole=hole))
        measured = [row for row in ordered if row.depth is not None]
        last_depth = measured[-1].depth if measured else None
        if measured and measured[0].depth is not None and measured[0].depth > 1e-9:
            findings.append(Finding("warning", "survey.first_station",
                                    "%s 的首个测斜站在 %s m，轨迹将从孔口按该站方向直连"
                                    % (hole, measured[0].depth),
                                    sheet=data.sheets[SURVEY], row=measured[0].row, hole=hole))
        if last_depth is not None and collar.total_depth is not None and \
                last_depth < collar.total_depth - 1e-9:
            length = collar.total_depth - last_depth
            findings.append(Finding("warning", "survey.short_of_total_depth",
                                    "%s 的末测斜站为 %s m，距总深度 %s m 还差 %.2f m；"
                                    "按当前策略%s"
                                    % (hole, last_depth, collar.total_depth, length,
                                       "沿末站方向外推" if extrapolate == "last"
                                       else "将在末站截止"),
                                    sheet=data.sheets[SURVEY], row=measured[-1].row, hole=hole,
                                    field="测斜深度", fixable=False))
            if length > max_extrapolation:
                findings.append(Finding("warning", "survey.extrapolation_long",
                                        "%s 需要外推 %.2f m，超过提示阈值 %.2f m"
                                        % (hole, length, max_extrapolation),
                                        sheet=data.sheets[SURVEY], hole=hole))

    for component in data.components:
        if not units.get(component):
            findings.append(Finding("error", "component.unit_missing",
                                    "矿物元素 '%s' 没有声明单位；请用 units={'%s': '%%'} 显式给出"
                                    % (component, component), field=component))
    for row in data.samples:
        collar = collars.get(row.hole)
        if row.hole not in collars:
            findings.append(Finding("error", "sample.unknown_hole",
                                    "样品表引用了孔口表没有的钻孔 '%s'" % row.hole,
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole))
            continue
        if not row.number:
            findings.append(Finding("warning", "sample.missing_number",
                                    "%s 有一条样品没有样号" % row.hole,
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole,
                                    field="样号"))
        if row.from_depth is None or row.to_depth is None:
            continue
        if not (0 <= row.from_depth < row.to_depth):
            findings.append(Finding("error", "sample.invalid_interval",
                                    "%s 样品 %s 的区间无效: 从 %s 至 %s"
                                    % (row.hole, row.number or "?", row.from_depth,
                                       row.to_depth),
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole,
                                    fixable=row.from_depth > row.to_depth))
        if collar.total_depth is not None and row.to_depth > collar.total_depth + 1e-9:
            findings.append(Finding("error", "sample.beyond_total_depth",
                                    "%s 样品 %s 的至深 %s 超过总深度 %s"
                                    % (row.hole, row.number or "?", row.to_depth,
                                       collar.total_depth),
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole))
        if row.length is not None and abs(row.length - (row.to_depth - row.from_depth)) > 1e-6:
            findings.append(Finding("warning", "sample.length_mismatch",
                                    "%s 样品 %s 的样长 %s 与 至−从 %s 不一致；入库以 至−从 为准"
                                    % (row.hole, row.number or "?", row.length,
                                       row.to_depth - row.from_depth),
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole,
                                    field="样长"))
        measured = [item.depth for item in surveys.get(row.hole, [])
                    if item.depth is not None]
        last_survey = max(measured) if measured else None
        if last_survey is not None and row.to_depth > last_survey + 1e-9:
            length = row.to_depth - last_survey
            severity = "error" if extrapolate == "stop" else "warning"
            findings.append(Finding(severity, "sample.beyond_survey",
                                    "%s 样品 %s 的至深 %s 超过末测斜站 %s（%.2f m）"
                                    % (row.hole, row.number or "?", row.to_depth,
                                       last_survey, length),
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole))
        if row.to_depth - row.from_depth > max_sample_length:
            findings.append(Finding("info", "sample.long",
                                    "%s 样品 %s 长 %.2f m，超过提示阈值 %.2f m"
                                    % (row.hole, row.number or "?",
                                       row.to_depth - row.from_depth, max_sample_length),
                                    sheet=data.sheets[SAMPLE], row=row.row, hole=row.hole))
    for hole, rows in samples.items():
        ordered = sorted([row for row in rows if row.from_depth is not None and
                          row.to_depth is not None],
                         key=lambda row: (row.from_depth, row.to_depth, row.row))
        for first, second in zip(ordered, ordered[1:]):
            if second.from_depth < first.to_depth - 1e-9:
                findings.append(Finding("warning", "sample.overlap",
                                        "%s 样品 %s 与 %s 重叠"
                                        % (hole, first.number or first.row,
                                           second.number or second.row),
                                        sheet=data.sheets[SAMPLE],
                                        rows=[first.row, second.row], hole=hole))
            elif second.from_depth > first.to_depth + 1e-9:
                findings.append(Finding("info", "sample.gap",
                                        "%s 样品在 %s–%s 之间有空档"
                                        % (hole, first.to_depth, second.from_depth),
                                        sheet=data.sheets[SAMPLE],
                                        rows=[first.row, second.row], hole=hole))
        numbers = defaultdict(list)
        for row in rows:
            if row.number:
                numbers[row.number].append(row.row)
        duplicates = {number: items for number, items in numbers.items() if len(items) > 1}
        if duplicates:
            findings.append(Finding("warning", "sample.duplicate_number",
                                    "%s 有 %d 个样号重复（不同区间共用样号，样号不作为身份）"
                                    % (hole, len(duplicates)),
                                    sheet=data.sheets[SAMPLE], hole=hole,
                                    rows=sorted(row for items in duplicates.values()
                                                for row in items)))
    for component in data.components:
        missing = sum(1 for row in data.samples if row.components.get(component) is None)
        if missing:
            findings.append(Finding("info", "component.missing_values",
                                    "矿物元素 '%s' 有 %d 个空值" % (component, missing),
                                    sheet=data.sheets[SAMPLE], field=component))
        zeros = sum(1 for row in data.samples
                    if row.components.get(component) is not None and
                    abs(row.components[component]) < 1e-12)
        if zeros:
            findings.append(Finding("info", "component.zero_values",
                                    "矿物元素 '%s' 有 %d 个零值" % (component, zeros),
                                    sheet=data.sheets[SAMPLE], field=component))

    for row in data.lithologies:
        collar = collars.get(row.hole)
        if row.hole not in collars:
            findings.append(Finding("error", "lithology.unknown_hole",
                                    "岩性表引用了孔口表没有的钻孔 '%s'" % row.hole,
                                    sheet=data.sheets[LITHOLOGY], row=row.row, hole=row.hole))
            continue
        if not row.rock:
            findings.append(Finding("error", "lithology.empty_rock",
                                    "%s 有一条岩性记录没有岩性名" % row.hole,
                                    sheet=data.sheets[LITHOLOGY], row=row.row, hole=row.hole,
                                    field="岩性"))
        if row.from_depth is None or row.to_depth is None:
            continue
        if not (0 <= row.from_depth < row.to_depth):
            findings.append(Finding("error", "lithology.invalid_interval",
                                    "%s 岩性区间无效: 从 %s 至 %s"
                                    % (row.hole, row.from_depth, row.to_depth),
                                    sheet=data.sheets[LITHOLOGY], row=row.row, hole=row.hole,
                                    fixable=row.from_depth > row.to_depth))
        if collar.total_depth is not None and row.to_depth > collar.total_depth + 1e-9:
            findings.append(Finding("error", "lithology.beyond_total_depth",
                                    "%s 岩性至深 %s 超过总深度 %s"
                                    % (row.hole, row.to_depth, collar.total_depth),
                                    sheet=data.sheets[LITHOLOGY], row=row.row, hole=row.hole))
        measured = [item.depth for item in surveys.get(row.hole, [])
                    if item.depth is not None]
        last_survey = max(measured) if measured else None
        if last_survey is not None and row.to_depth > last_survey + 1e-9:
            severity = "error" if extrapolate == "stop" else "warning"
            findings.append(Finding(severity, "lithology.beyond_survey",
                                    "%s 岩性至深 %s 超过末测斜站 %s（%.2f m）"
                                    % (row.hole, row.to_depth, last_survey,
                                       row.to_depth - last_survey),
                                    sheet=data.sheets[LITHOLOGY], row=row.row, hole=row.hole))
    for hole, rows in lithologies.items():
        ordered = sorted([row for row in rows if row.from_depth is not None and
                          row.to_depth is not None],
                         key=lambda row: (row.from_depth, row.to_depth, row.row))
        for first, second in zip(ordered, ordered[1:]):
            if second.from_depth < first.to_depth - 1e-9:
                findings.append(Finding("warning", "lithology.overlap",
                                        "%s 岩性区间 %s–%s 与 %s–%s 重叠"
                                        % (hole, first.from_depth, first.to_depth,
                                           second.from_depth, second.to_depth),
                                        sheet=data.sheets[LITHOLOGY],
                                        rows=[first.row, second.row], hole=hole))
            elif second.from_depth > first.to_depth + 1e-9:
                findings.append(Finding("info", "lithology.gap",
                                        "%s 岩性在 %s–%s 之间有空档"
                                        % (hole, first.to_depth, second.from_depth),
                                        sheet=data.sheets[LITHOLOGY],
                                        rows=[first.row, second.row], hole=hole))

    for hole, collar in collars.items():
        if not samples.get(hole):
            findings.append(Finding("info", "hole.no_samples",
                                    "%s 没有样品记录" % hole, hole=hole))
        if not lithologies.get(hole):
            findings.append(Finding("info", "hole.no_lithology",
                                    "%s 没有岩性记录" % hole, hole=hole,
                                    sheet=data.sheets[LITHOLOGY]))
    return findings


# ---------------------------------------------------------------------------
# Repairing


def _repair_code_names(repairs: Iterable[str] | None) -> tuple[str, ...]:
    if repairs is None:
        return SAFE_REPAIRS
    if isinstance(repairs, str):
        repairs = (repairs,)
    names = tuple(repairs)
    unknown = [name for name in names if name not in ALL_REPAIRS]
    if unknown:
        raise ValueError("unknown repair code(s): %s; known: %s"
                         % (", ".join(unknown), ", ".join(ALL_REPAIRS)))
    return names


def repair_exploration_data(data: ExplorationData, repairs: Iterable[str] | None = None,
                            *, units: dict[str, str] | None = None) -> tuple[ExplorationData, list[Repair]]:
    """Applies only the named repairs and records every change.

    None selects SAFE_REPAIRS, which change no measured value.  The optional
    codes can alter depths and are therefore never applied by default.
    """
    codes = _repair_code_names(repairs)
    result = copy.deepcopy(data)
    applied: list[Repair] = []
    total_depths = {collar.hole: collar.total_depth for collar in result.collars
                    if collar.hole}

    def remember(code: str, sheet: str, row: int | None, hole: str | None,
                 field_name: str | None, before: Any, after: Any, message: str) -> None:
        applied.append(Repair(code, sheet, row, hole, field_name, before, after, message))

    if "normalize_azimuth" in codes:
        for row in result.surveys:
            if row.azimuth is not None and not (0 <= row.azimuth < 360):
                before = row.azimuth
                row.azimuth = row.azimuth % 360
                remember("normalize_azimuth", result.sheets[SURVEY], row.row, row.hole,
                         "方位角", before, row.azimuth, "把方位角归一化到 [0, 360)")

    if "trim" in codes:
        for collar in result.collars:
            if collar.hole != collar.hole.strip():
                remember("trim", result.sheets[COLLAR], collar.row, collar.hole, "钻孔名称",
                         collar.hole, collar.hole.strip(), "去掉钻孔名称两端空白")
                collar.hole = collar.hole.strip()
            if collar.engineering_type and collar.engineering_type != collar.engineering_type.strip():
                remember("trim", result.sheets[COLLAR], collar.row, collar.hole,
                         "工程类型", collar.engineering_type,
                         collar.engineering_type.strip(), "去掉工程类型两端空白")
                collar.engineering_type = collar.engineering_type.strip()
        for row in result.surveys:
            if row.hole != row.hole.strip():
                remember("trim", result.sheets[SURVEY], row.row, row.hole, "钻孔名称",
                         row.hole, row.hole.strip(), "去掉钻孔名称两端空白")
                row.hole = row.hole.strip()
        for row in result.samples:
            if row.hole != row.hole.strip():
                remember("trim", result.sheets[SAMPLE], row.row, row.hole, "钻孔名称",
                         row.hole, row.hole.strip(), "去掉钻孔名称两端空白")
                row.hole = row.hole.strip()
            if row.number != row.number.strip():
                remember("trim", result.sheets[SAMPLE], row.row, row.hole, "样号",
                         row.number, row.number.strip(), "去掉样号两端空白")
                row.number = row.number.strip()
        for row in result.lithologies:
            if row.hole != row.hole.strip():
                remember("trim", result.sheets[LITHOLOGY], row.row, row.hole, "钻孔名称",
                         row.hole, row.hole.strip(), "去掉钻孔名称两端空白")
                row.hole = row.hole.strip()
            if row.rock != row.rock.strip():
                remember("trim", result.sheets[LITHOLOGY], row.row, row.hole, "岩性",
                         row.rock, row.rock.strip(), "去掉岩性名两端空白")
                row.rock = row.rock.strip()

    if "drop_duplicate_rows" in codes:
        result.collars, dropped = _dedupe(result.collars, result.sheets[COLLAR],
                                           lambda row: (row.hole, row.east, row.north,
                                                        row.elevation, row.total_depth,
                                                        row.line, row.engineering_type),
                                           "collar", remember)
        result.surveys, dropped = _dedupe(result.surveys, result.sheets[SURVEY],
                                           lambda row: (row.hole, row.depth, row.azimuth,
                                                        row.dip),
                                           "survey", remember)
        result.samples, dropped = _dedupe(result.samples, result.sheets[SAMPLE],
                                           lambda row: (row.hole, row.number, row.from_depth,
                                                        row.to_depth, row.length,
                                                        tuple(sorted(row.components.items()))),
                                           "sample", remember)
        result.lithologies, dropped = _dedupe(result.lithologies, result.sheets[LITHOLOGY],
                                               lambda row: (row.hole, row.from_depth,
                                                            row.to_depth, row.rock),
                                               "lithology", remember)

    if "swap_reversed" in codes:
        for row in result.samples:
            if row.from_depth is not None and row.to_depth is not None and \
                    row.from_depth > row.to_depth:
                before = (row.from_depth, row.to_depth)
                row.from_depth, row.to_depth = row.to_depth, row.from_depth
                remember("swap_reversed", result.sheets[SAMPLE], row.row, row.hole, "从/至",
                         list(before), [row.from_depth, row.to_depth], "交换倒置的样品区间")
        for row in result.lithologies:
            if row.from_depth is not None and row.to_depth is not None and \
                    row.from_depth > row.to_depth:
                before = (row.from_depth, row.to_depth)
                row.from_depth, row.to_depth = row.to_depth, row.from_depth
                remember("swap_reversed", result.sheets[LITHOLOGY], row.row, row.hole, "从/至",
                         list(before), [row.from_depth, row.to_depth], "交换倒置的岩性区间")

    if "extend_total_depth" in codes:
        for collar in result.collars:
            if not collar.hole:
                continue
            values = [row.depth for row in result.surveys
                      if row.hole == collar.hole and row.depth is not None]
            values += [row.to_depth for row in result.samples
                       if row.hole == collar.hole and row.to_depth is not None]
            values += [row.to_depth for row in result.lithologies
                       if row.hole == collar.hole and row.to_depth is not None]
            if values and collar.total_depth is not None and max(values) > collar.total_depth + 1e-9:
                before = collar.total_depth
                collar.total_depth = max(values)
                remember("extend_total_depth", result.sheets[COLLAR], collar.row, collar.hole,
                         "总深度", before, collar.total_depth,
                         "把总深度延长到最深测斜/区间")
                total_depths[collar.hole] = collar.total_depth

    if "clip_to_total_depth" in codes:
        for collection, sheet, name in ((result.samples, result.sheets[SAMPLE], "sample"),
                                        (result.lithologies, result.sheets[LITHOLOGY], "lithology")):
            kept = []
            for row in collection:
                limit = total_depths.get(row.hole)
                if row.from_depth is not None and row.to_depth is not None and \
                        limit is not None and row.to_depth > limit + 1e-9:
                    before = row.to_depth
                    row.to_depth = limit
                    remember("clip_to_total_depth", sheet, row.row, row.hole, "至",
                             before, row.to_depth, "把区间截到总深度")
                    if row.from_depth >= row.to_depth - 1e-9:
                        remember("clip_to_total_depth", sheet, row.row, row.hole, "删除区间",
                                 [row.from_depth, before], None,
                                 "截断后区间为空，删除该行")
                        continue
                kept.append(row)
            if name == "sample":
                result.samples = kept
            else:
                result.lithologies = kept

    if "trim_lithology_overlaps" in codes:
        per_hole: dict[str, list[LithologyRow]] = defaultdict(list)
        for row in result.lithologies:
            per_hole[row.hole].append(row)
        kept: list[LithologyRow] = []
        for hole, rows in per_hole.items():
            ordered = sorted(rows, key=lambda row: (row.from_depth
                                                    if row.from_depth is not None else math.inf,
                                                    row.to_depth
                                                    if row.to_depth is not None else math.inf,
                                                    row.row))
            previous_to: float | None = None
            for row in ordered:
                if row.from_depth is None or row.to_depth is None:
                    kept.append(row)
                    continue
                if previous_to is not None and row.from_depth < previous_to - 1e-9:
                    before = row.from_depth
                    row.from_depth = previous_to
                    remember("trim_lithology_overlaps", result.sheets[LITHOLOGY], row.row,
                             row.hole, "从", before, row.from_depth,
                             "把后一岩性区间的起点截到前一区间终点")
                    if row.from_depth >= row.to_depth - 1e-9:
                        remember("trim_lithology_overlaps", result.sheets[LITHOLOGY], row.row,
                                 row.hole, "删除区间", [before, row.to_depth], None,
                                 "裁剪后区间为空，删除该行")
                        continue
                kept.append(row)
                previous_to = row.to_depth if previous_to is None else max(previous_to,
                                                                           row.to_depth)
        result.lithologies = kept
    return result, applied


def _dedupe(rows: list[Any], sheet: str, key, name: str, remember) -> tuple[list[Any], int]:
    kept: list[Any] = []
    seen: dict[Any, Any] = {}
    for row in rows:
        signature = key(row)
        if signature in seen:
            remember("drop_duplicate_rows", sheet, row.row, row.hole, None,
                     getattr(row, "number", None) or list(signature), None,
                     "删除与第 %d 行完全相同的记录" % seen[signature].row)
            continue
        seen[signature] = row
        kept.append(row)
    return kept, len(rows) - len(kept)


# ---------------------------------------------------------------------------
# Statistics


def exploration_statistics(data: ExplorationData, *, units: dict[str, str] | None = None) -> dict[str, Any]:
    units = dict(DEFAULT_UNITS) if units is None else dict(units)
    collars, _ = _collars_by_hole(data)
    surveys = _surveys_by_hole(data)
    samples = _samples_by_hole(data)
    lithologies = _lithologies_by_hole(data)
    component_stats: dict[str, Any] = {}
    for component in data.components:
        values = [row.components.get(component) for row in data.samples]
        present = [value for value in values if value is not None]
        component_stats[component] = {
            "unit": units.get(component),
            "count": len(present),
            "missing": len(values) - len(present),
            "minimum": min(present) if present else None,
            "maximum": max(present) if present else None,
            "mean": sum(present) / len(present) if present else None,
        }
    lengths = [row.to_depth - row.from_depth for row in data.samples
               if row.from_depth is not None and row.to_depth is not None]
    holes: dict[str, Any] = {}
    for hole, collar in collars.items():
        rows = sorted([row for row in surveys.get(hole, []) if row.depth is not None],
                      key=lambda row: row.depth)
        measured = [row.depth for row in rows]
        sample_rows = sorted([row for row in samples.get(hole, [])
                              if row.from_depth is not None and row.to_depth is not None],
                             key=lambda row: (row.from_depth, row.to_depth))
        lithology_rows = sorted([row for row in lithologies.get(hole, [])
                                 if row.from_depth is not None and row.to_depth is not None],
                                key=lambda row: (row.from_depth, row.to_depth))
        doglegs = [_dogleg(rows[index - 1], rows[index]) for index in range(1, len(rows))]
        holes[hole] = {
            "east": collar.east, "north": collar.north, "elevation": collar.elevation,
            "total_depth": collar.total_depth, "line": collar.line,
            "engineering_type": collar.engineering_type,
            "survey_stations": len(rows), "last_survey_depth": measured[-1] if measured else None,
            "max_dogleg_degrees": max(doglegs) if doglegs else None,
            "samples": len(sample_rows), "lithology_intervals": len(lithology_rows),
            "sample_length": sum(row.to_depth - row.from_depth for row in sample_rows),
        }
    return {
        "counts": {
            "holes": len(collars), "collar_rows": len(data.collars),
            "survey_stations": len(data.surveys), "samples": len(data.samples),
            "lithology_intervals": len(data.lithologies),
            "components": list(data.components),
        },
        "components": component_stats,
        "sample_length": {
            "count": len(lengths),
            "minimum": min(lengths) if lengths else None,
            "maximum": max(lengths) if lengths else None,
            "mean": sum(lengths) / len(lengths) if lengths else None,
        },
        "extent": {
            "east": _extent([collar.east for collar in data.collars
                             if collar.east is not None]),
            "north": _extent([collar.north for collar in data.collars
                              if collar.north is not None]),
            "elevation": _extent([collar.elevation for collar in data.collars
                                  if collar.elevation is not None]),
        },
        "holes": holes,
    }


def _extent(values: list[float]) -> list[float]:
    return [min(values), max(values)] if values else []


# ---------------------------------------------------------------------------
# Import


def _slug(value: str) -> str:
    result = re.sub(r"[^0-9A-Za-z_.\-一-鿿]+", "-", value).strip("-")
    return result or "dataset"


def _field(name: str, type_code: int, unit: str | None = None,
           categories: list[dict[str, Any]] | None = None,
           description: str | None = None,
           label: str | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"id": name, "name": label if label else name,
                             "type": type_code}
    if unit is not None:
        value["unit"] = unit
    if categories:
        value["categories"] = categories
    if description:
        value["description"] = description
    return value


def _categories(names: Sequence[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    ordered = sorted({name for name in names if name})
    return ([{"value": index + 1, "name": name} for index, name in enumerate(ordered)],
            {name: index + 1 for index, name in enumerate(ordered)})


def _values(values: Sequence[Any], kind: str) -> dict[str, Any]:
    flags = [value is not None for value in values]
    payload: dict[str, Any] = {}
    if kind == "number":
        payload["float64s"] = [0.0 if value is None else float(value) for value in values]
    elif kind == "integer":
        payload["int64s"] = [0 if value is None else int(value) for value in values]
    elif kind == "text":
        payload["texts"] = ["" if value is None else str(value) for value in values]
    else:
        raise ValueError(kind)
    if not all(flags):
        payload["validity"] = _mask(flags)
    return payload


def _mask(flags: Sequence[bool]) -> list[int]:
    result = [0] * ((len(flags) + 7) // 8)
    for index, flag in enumerate(flags):
        if flag:
            result[index // 8] |= 1 << (index % 8)
    return result


def _default_frame(source: Path) -> dict[str, Any]:
    return {
        "id": "frame.local",
        "name": "Local mine grid",
        "vertical_datum": "local",
        "metres_per_unit": 1.0,
        "located": True,
        "origin_metres": {"x": 0.0, "y": 0.0, "z": 0.0},
        "yaw_degrees": 0.0,
        "epsg": 0,
        "wkt": "",
    }


def _line_type(data: ExplorationData) -> int:
    values = [collar.line for collar in data.collars if collar.line]
    if values and not all(_is_integer_text(value) for value in values):
        return _abi.VALUE_TEXT
    return _abi.VALUE_INTEGER


def _build_payload(data: ExplorationData, units: dict[str, str], *, project_id: str,
                   project_name: str, parent_id: str, parent_name: str,
                   frame: dict[str, Any], source: Path) -> dict[str, Any]:
    collars, _ = _collars_by_hole(data)
    line_type = _line_type(data)
    engineering_categories, engineering_codes = _categories(
        [collar.engineering_type for collar in data.collars if collar.engineering_type])
    rock_categories, rock_codes = _categories([row.rock for row in data.lithologies
                                               if row.rock])
    fields: list[dict[str, Any]] = [
        _field("drill.kind", _abi.VALUE_INTEGER, "1",
               [{"value": 1, "name": "钻孔"}], "钻孔数据集的孔对象"),
        _field("drill.line", line_type, "1" if line_type == _abi.VALUE_INTEGER else None,
               None, "勘探线号"),
        _field("drill.engineeringType", _abi.VALUE_INTEGER, "1", engineering_categories,
               "工程类型；空白为 null"),
        _field("sample.number", _abi.VALUE_TEXT, None, None, "源样号，允许重复"),
        _field("lithology.rock", _abi.VALUE_INTEGER, "1", rock_categories, "岩性"),
    ]
    for component in data.components:
        fields.append(_field("component." + component, _abi.VALUE_NUMBER,
                             units.get(component, "1"), None,
                             "样品矿物元素 %s" % component, label=component))

    elements = [{"id": parent_id, "name": parent_name,
                 "metadata": json.dumps({"source": str(source), "imported": "drillholes"},
                                        ensure_ascii=False)}]
    columns: list[dict[str, Any]] = []
    for collar in data.collars:
        if not collar.hole or collar.hole not in collars or collars[collar.hole] is not collar:
            continue
        hole_id = _hole_id(collar.hole)
        elements.append({"id": hole_id, "name": collar.hole, "parent_id": parent_id,
                         "metadata": json.dumps({"source_row": collar.row},
                                                ensure_ascii=False)})
        columns.append({"id": hole_id + "/drill.kind", "element_id": hole_id,
                        "field_id": "drill.kind", "location": 0,
                        "payload": _values([1], "integer")})
        if line_type == _abi.VALUE_INTEGER:
            value = int(float(collar.line)) if collar.line else None
            columns.append({"id": hole_id + "/drill.line", "element_id": hole_id,
                            "field_id": "drill.line", "location": 0,
                            "payload": _values([value], "integer")})
        else:
            columns.append({"id": hole_id + "/drill.line", "element_id": hole_id,
                            "field_id": "drill.line", "location": 0,
                            "payload": _values([collar.line], "text")})
        code = engineering_codes.get(collar.engineering_type) if collar.engineering_type else None
        columns.append({"id": hole_id + "/drill.engineeringType", "element_id": hole_id,
                        "field_id": "drill.engineeringType", "location": 0,
                        "payload": _values([code], "integer")})
    return {
        "project": {"id": project_id, "name": project_name,
                    "project_reference": "local grid of %s" % source.name,
                    "frame": frame},
        "fields": fields,
        "elements": elements,
        "attribute_columns": columns,
        "engineering_codes": engineering_codes,
        "rock_codes": rock_codes,
        "line_type": line_type,
    }


def _hole_id(name: str) -> str:
    return "drill." + name


def _trace_id(hole_id: str) -> str:
    return hole_id + ".trace"


def _samples_id(hole_id: str) -> str:
    return hole_id + ".samples"


def _lithology_id(hole_id: str) -> str:
    return hole_id + ".lithology"


def _sorted_samples(rows: Sequence[SampleRow]) -> list[SampleRow]:
    return sorted([row for row in rows if row.from_depth is not None and
                   row.to_depth is not None],
                  key=lambda row: (row.from_depth, row.to_depth, row.row))


def _sorted_lithologies(rows: Sequence[LithologyRow]) -> list[LithologyRow]:
    return sorted([row for row in rows if row.from_depth is not None and
                   row.to_depth is not None],
                  key=lambda row: (row.from_depth, row.to_depth, row.row))


def _sorted_surveys(rows: Sequence[SurveyRow]) -> list[SurveyRow]:
    return sorted([row for row in rows if row.depth is not None],
                  key=lambda row: (row.depth, row.row))


def _build_project(data: ExplorationData, units: dict[str, str], *, project_id: str,
                   project_name: str, parent_id: str, parent_name: str,
                   frame: dict[str, Any] | None, source: Path, extrapolate: str,
                   save: bool, output: Path | None, library=None) -> tuple[Port, int]:
    from . import load as _load  # late: __init__ imports this module at the end

    payload = _build_payload(data, units, project_id=project_id,
                             project_name=project_name, parent_id=parent_id,
                             parent_name=parent_name,
                             frame=frame or _default_frame(source), source=source)
    port = Port(library or _load())
    try:
        port.create(payload["project"])
        port.put({"fields": payload["fields"], "elements": payload["elements"],
                  "attribute_columns": payload["attribute_columns"]})
        collars, _ = _collars_by_hole(data)
        samples = _samples_by_hole(data)
        lithologies = _lithologies_by_hole(data)
        surveys = _surveys_by_hole(data)
        for collar in data.collars:
            if not collar.hole or collars.get(collar.hole) is not collar:
                continue
            hole_id = _hole_id(collar.hole)
            trace_id = _trace_id(hole_id)
            stations = _sorted_surveys(surveys.get(collar.hole, []))
            port.put_drill_hole(
                {"id": trace_id, "name": collar.hole + " 轨迹",
                 "source": "%s/%s+%s" % (source.name, data.sheets[COLLAR],
                                         data.sheets[SURVEY])},
                (collar.east, collar.north, collar.elevation),
                collar.total_depth,
                [(row.depth, row.azimuth, row.dip) for row in stations],
                hole_id, extrapolate=extrapolate == "last")
            sample_rows = _sorted_samples(samples.get(collar.hole, []))
            if sample_rows:
                line_set_id = _samples_id(hole_id)
                port.put_drill_intervals(
                    {"id": line_set_id, "name": collar.hole + " 样品",
                     "source": "%s/%s" % (source.name, data.sheets[SAMPLE])},
                    hole_id, trace_id, _abi.DRILL_SAMPLE_INTERVAL,
                    [(row.from_depth, row.to_depth) for row in sample_rows])
                sample_columns = [{"id": line_set_id + "/sample.number",
                                   "element_id": hole_id, "field_id": "sample.number",
                                   "geometry_id": line_set_id, "location": 2,
                                   "payload": _values([row.number or None for row in sample_rows],
                                                      "text")}]
                for component in data.components:
                    sample_columns.append({
                        "id": line_set_id + "/component." + component,
                        "element_id": hole_id, "field_id": "component." + component,
                        "geometry_id": line_set_id, "location": 2,
                        "payload": _values([row.components.get(component) for row in sample_rows],
                                           "number")})
                port.put({"attribute_columns": sample_columns})
            lithology_rows = _sorted_lithologies(lithologies.get(collar.hole, []))
            if lithology_rows:
                line_set_id = _lithology_id(hole_id)
                port.put_drill_intervals(
                    {"id": line_set_id, "name": collar.hole + " 岩性",
                     "source": "%s/%s" % (source.name, data.sheets[LITHOLOGY])},
                    hole_id, trace_id, _abi.DRILL_LITHOLOGY_INTERVAL,
                    [(row.from_depth, row.to_depth) for row in lithology_rows])
                port.put({"attribute_columns": [{
                    "id": line_set_id + "/lithology.rock", "element_id": hole_id,
                    "field_id": "lithology.rock", "geometry_id": line_set_id,
                    "location": 2,
                    "payload": _values([payload["rock_codes"].get(row.rock)
                                        for row in lithology_rows], "integer")}]})
        port.commit()
        if save:
            if output is None:
                raise ExplorationDataError("没有指定输出文件")
            port.save(output)
        return port, port.revision
    except Exception:
        port.close()
        raise


def _report_findings(findings: Sequence[Finding]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    order = {"error": 0, "warning": 1, "info": 2}
    ordered = sorted(findings, key=lambda item: (order.get(item.severity, 3),
                                                 item.sheet or "", item.row or 0,
                                                 item.code))
    summary = {"errors": sum(1 for item in findings if item.severity == "error"),
               "warnings": sum(1 for item in findings if item.severity == "warning"),
               "infos": sum(1 for item in findings if item.severity == "info")}
    return [item.to_dict() for item in ordered], summary


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8")


def _unit_overrides(values: Sequence[str] | None) -> dict[str, str]:
    units = dict(DEFAULT_UNITS)
    for value in values or []:
        if "=" not in value:
            raise ValueError("unit must be ELEMENT=UNIT, not %r" % value)
        name, unit = value.split("=", 1)
        units[name.strip()] = unit.strip()
    return units


def import_exploration_data(xlsx: str | Path, output: str | Path | None = None, *,
                            sheets: dict[str, str] | None = None,
                            component_columns: Sequence[str] | None = None,
                            project_id: str | None = None,
                            project_name: str | None = None,
                            parent_id: str | None = None,
                            parent_name: str | None = None,
                            frame: dict[str, Any] | None = None,
                            units: dict[str, str] | None = None,
                            extrapolate: str = "last",
                            max_extrapolation: float = MAX_EXTRAPOLATION_DEFAULT,
                            max_sample_length: float = MAX_SAMPLE_LENGTH_DEFAULT,
                            max_dogleg_degrees: float = MAX_DOGLEG_DEFAULT,
                            repair: bool | Iterable[str] = False,
                            strict: bool = False,
                            report_path: str | Path | None = None,
                            repair_report_path: str | Path | None = None,
                            save: bool = True,
                            library=None) -> ImportResult:
    """Reads, checks, optionally repairs and imports an exploration workbook.

    Defaults: output beside the workbook with ``.iamh``; TFe in percent; the
    last survey direction extrapolated to the hole's total depth; no repair;
    warnings do not block.  The QC and repair reports are always written next
    to the output unless explicit paths are given.

    ``repair`` is False (no repair), True (the safe set), or an iterable of
    repair codes.  ``strict`` turns warnings into blockers.
    """
    source = Path(xlsx)
    output_path = Path(output) if output is not None else source.with_suffix(".iamh")
    report_path = Path(report_path) if report_path is not None else \
        (output_path.with_suffix(".qc.json"))
    repair_report_path = Path(repair_report_path) if repair_report_path is not None else \
        (output_path.with_suffix(".repair.json"))
    units = dict(DEFAULT_UNITS) if units is None else dict(units)
    if extrapolate not in ("last", "stop"):
        raise ValueError("extrapolate must be 'last' or 'stop'")
    if repair is False:
        repair_codes: tuple[str, ...] = ()
    elif repair is True:
        repair_codes = SAFE_REPAIRS
    else:
        repair_codes = _repair_code_names(repair)
    if project_id is None:
        project_id = "drill." + _slug(source.stem)
    if project_name is None:
        project_name = source.stem
    if parent_id is None:
        parent_id = "exploration." + _slug(source.stem)
    if parent_name is None:
        parent_name = "探矿工程 " + source.stem
    reports = {"qc": report_path, "repair": repair_report_path}
    counts: dict[str, Any] = {}
    statistics: dict[str, Any] = {}
    result = ImportResult(ok=False, source=source, output=None, project_id=project_id,
                          revision=None, counts=counts, findings=[], repairs=[],
                          reports=reports)
    try:
        data = read_exploration_workbook(source, sheets=sheets,
                                         component_columns=component_columns)
    except ExplorationDataError as error:
        finding = Finding("error", "workbook.read", str(error))
        findings, summary = _report_findings([finding])
        _write_json(report_path, {
            "source": str(source), "generated": _now(), "qualified": False,
            "strict": strict, "blocked": True, "counts": {}, "statistics": {},
            "findings": findings, "summary": summary,
        })
        _write_json(repair_report_path, {
            "source": str(source), "generated": _now(), "applied": [],
            "summary": {"repairs": 0}, "note": "工作簿无法读取，未执行修复",
        })
        result.findings = [finding]
        result.error = str(error)
        return result
    pre_findings = check_exploration_data(
        data, units=units, extrapolate=extrapolate,
        max_extrapolation=max_extrapolation, max_sample_length=max_sample_length,
        max_dogleg_degrees=max_dogleg_degrees)
    pre_summary = _report_findings(pre_findings)[1]
    applied: list[Repair] = []
    if repair_codes:
        data, applied = repair_exploration_data(data, repair_codes, units=units)
    findings = check_exploration_data(
        data, units=units, extrapolate=extrapolate,
        max_extrapolation=max_extrapolation, max_sample_length=max_sample_length,
        max_dogleg_degrees=max_dogleg_degrees)
    statistics = exploration_statistics(data, units=units)
    counts = statistics["counts"]
    blocking = [item for item in findings
                if item.severity == "error" or (strict and item.severity == "warning")]
    report_findings, summary = _report_findings(findings)
    qualified = summary["errors"] == 0

    def write_reports(extra: list[Finding] | None = None, error: str | None = None) -> None:
        all_findings = findings + (extra or [])
        ordered, final_summary = _report_findings(all_findings)
        final_qualified = final_summary["errors"] == 0
        final_blocked = final_summary["errors"] > 0 or \
            (strict and final_summary["warnings"] > 0) or error is not None
        _write_json(report_path, {
            "source": str(source), "generated": _now(), "qualified": final_qualified,
            "strict": strict, "blocked": final_blocked,
            "counts": counts, "statistics": statistics, "findings": ordered,
            "summary": final_summary,
            "pre_repair_summary": pre_summary,
            "repairs_applied": len(applied),
            "error": error,
        })
        _write_json(repair_report_path, {
            "source": str(source), "generated": _now(),
            "applied": [item.to_dict() for item in applied],
            "summary": {"repairs": len(applied)},
            "pre_repair_summary": pre_summary,
            "post_repair_summary": final_summary,
            "note": ("未启用修复" if not repair_codes else
                     "修复只包含调用方指定的项；深度/区间未被任何未指定规则改动"),
        })

    if blocking:
        write_reports()
        result.findings = findings
        result.repairs = applied
        result.statistics = statistics
        result.error = "数据未通过合格性检查（%d 个错误，%d 个警告）" % (
            summary["errors"], summary["warnings"])
        return result
    try:
        port, revision = _build_project(
            data, units, project_id=project_id, project_name=project_name,
            parent_id=parent_id, parent_name=parent_name, frame=frame, source=source,
            extrapolate=extrapolate, save=save, output=output_path, library=library)
    except (IamError, ExplorationDataError, ValueError, OSError) as error:
        finding = Finding("error", "import.build", str(error))
        findings.append(finding)
        write_reports(error=str(error))
        result.findings = findings
        result.repairs = applied
        result.statistics = statistics
        result.error = str(error)
        return result
    try:
        write_reports()
    finally:
        if save:
            port.close()
    result.ok = True
    result.output = output_path if save else None
    result.revision = revision
    result.findings = findings
    result.repairs = applied
    result.statistics = statistics
    result.counts = counts
    if not save:
        result.port = port
    return result


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Exporting back to the four-sheet workbook
#
# The reverse mapping is deliberately semantic rather than element-id-based: a
# hole is an element that owns a Polyline3d carrying the platform's
# drill.totalDepth column, its survey is that trace's vertex columns, and its
# intervals are the LineSets carrying interval.kind.  A project that went
# through the native import's merge has namespaced ids (`merge-1-drill.CK7610`),
# and the merge renames FIELDS the same way, so every field id is matched after
# _logical_field_id() removes that namespace.

_DRILL_DEPTH = "drill.depth"
_DRILL_AZIMUTH = "drill.azimuth"
_DRILL_DIP = "drill.dip"
_DRILL_TOTAL_DEPTH = "drill.totalDepth"
_DRILL_LINE = "drill.line"
_DRILL_ENGINEERING_TYPE = "drill.engineeringType"
_INTERVAL_FROM = "interval.from"
_INTERVAL_TO = "interval.to"
_INTERVAL_KIND = "interval.kind"
_SAMPLE_NUMBER = "sample.number"
_LITHOLOGY_ROCK = "lithology.rock"
_COMPONENT_PREFIX = "component."
_LOCATION_GEOMETRY = _abi.LOCATION_GEOMETRY
_LOCATION_PART = _abi.LOCATION_PART
_LOCATION_VERTEX = _abi.LOCATION_VERTEX


@dataclass
class ExportResult:
    ok: bool
    project: str | None
    output: Path | None
    counts: dict[str, Any]
    findings: list[Finding]
    error: str | None = None


def _xlsx_escape(value: Any) -> str:
    return (str(value).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _xlsx_cell(reference: str, value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return '<c r="%s"><v>%s</v></c>' % (reference, repr(value))
    return ('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>'
            % (reference, _xlsx_escape(value)))


def _xlsx_column(index: int) -> str:
    result = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def write_exploration_workbook(data: ExplorationData, path: str | Path) -> None:
    """Writes the four-sheet workbook from ExplorationData.

    The sheets and headers are the ones read_exploration_workbook() accepts, so
    the result is a workbook this importer can read back.  Cells are inline
    strings and numeric values; a missing value is an empty cell.
    """
    sheet_names = dict(DEFAULT_SHEETS)
    sheet_names.update(data.sheets or {})
    collar_rows: list[list[Any]] = [
        ["钻孔名称", "东坐标", "北坐标", "高程", "总深度", "勘探线号", "工程类型"]]
    for row in data.collars:
        collar_rows.append([row.hole, row.east, row.north, row.elevation,
                            row.total_depth, row.line, row.engineering_type])
    survey_rows: list[list[Any]] = [["钻孔名称", "测斜深度", "方位角", "倾角"]]
    for row in data.surveys:
        survey_rows.append([row.hole, row.depth, row.azimuth, row.dip])
    sample_rows: list[list[Any]] = [
        ["钻孔名称", "样号", "从", "至", "样长"] + list(data.components)]
    for row in data.samples:
        values: list[Any] = [row.hole, row.number, row.from_depth, row.to_depth,
                             row.length]
        values.extend(row.components.get(component) for component in data.components)
        sample_rows.append(values)
    lithology_rows: list[list[Any]] = [["钻孔名称", "从", "至", "岩性"]]
    for row in data.lithologies:
        lithology_rows.append([row.hole, row.from_depth, row.to_depth, row.rock])
    _write_xlsx(path, {
        sheet_names[COLLAR]: collar_rows,
        sheet_names[SURVEY]: survey_rows,
        sheet_names[SAMPLE]: sample_rows,
        sheet_names[LITHOLOGY]: lithology_rows,
    })


def _write_xlsx(path: str | Path, sheets: dict[str, list[list[Any]]]) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Written beside the target and published only when complete: opening the
    # destination directly truncated the user's previous export before the new
    # one was known good.
    temporary = destination.with_name(destination.name + ".tmp-" + str(os.getpid()))
    try:
        _write_xlsx_file(temporary, sheets)
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _write_xlsx_file(target: Path, sheets: dict[str, list[list[Any]]]) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        entries = []
        for number, (name, rows) in enumerate(sheets.items(), 1):
            xml_rows = []
            for row_number, row in enumerate(rows, 1):
                cells = "".join(
                    _xlsx_cell(_xlsx_column(column) + str(row_number), value)
                    for column, value in enumerate(row))
                xml_rows.append('<row r="%d">%s</row>' % (row_number, cells))
            worksheet = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetData>%s</sheetData></worksheet>' % "".join(xml_rows))
            archive.writestr("xl/worksheets/sheet%d.xml" % number, worksheet)
            entries.append((name, number))
        workbook = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets>%s</sheets></workbook>' % "".join(
                '<sheet name="%s" sheetId="%d" r:id="rId%d"/>'
                % (_xlsx_escape(name), number, number) for name, number in entries))
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '%s</Relationships>' % "".join(
                '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/'
                'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>'
                % (number, number) for _, number in entries))
        archive.writestr("[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.sheet.main+xml"/>'
            '%s</Types>' % "".join(
                '<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/'
                'vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % number
                for _, number in entries))
        archive.writestr("_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
            'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')


_MERGE_NAMESPACE = re.compile(r"^merge-\d+-")


def _logical_field_id(field_id: str) -> str:
    """The field id the platform defined, with any merge namespace removed.

    IamProjectMerge gives every resource it appends an id of the form
    ``merge-<n>-<original>`` -- fields included -- so a project filled by the
    native importer carries ``merge-1-drill.totalDepth`` where the Python
    importer would have ``drill.totalDepth``.  A merged project can be merged
    again, so the prefixes are removed until there is none left.  Only that
    exact shape is stripped: a user-defined id merely containing "merge-" keeps
    it.
    """
    value = field_id
    while True:
        match = _MERGE_NAMESPACE.match(value)
        if not match:
            return value
        value = value[match.end():]


def _export_field(port: Port, field_id: str,
                  cache: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if field_id not in cache:
        cache[field_id] = port.resource(_abi.RESOURCE_FIELD, field_id)
    return cache[field_id]


def _export_category_name(port: Port, field_id: str, code: Any,
                          cache: dict[str, dict[str, Any]]) -> str | None:
    if code is None:
        return None
    field_value = _export_field(port, field_id, cache)
    for category in field_value.get("categories", []):
        if category.get("value") == code:
            return category.get("name")
    return None


def read_exploration_project(port: Port, *, project_name: str | None = None
                             ) -> tuple[ExplorationData, list[Finding]]:
    """Reconstructs ExplorationData from the drilling resources in a project.

    A hole is found by the platform's own marker -- an element owning a
    Polyline3d with a drill.totalDepth column -- rather than by an id prefix, so
    a project that went through the native importer's merge exports the same as
    one just built by the Python importer.  The merge renames fields as well as
    resources, so every field id is compared after _logical_field_id() removes
    its namespace.
    """
    findings: list[Finding] = []
    fields: dict[str, dict[str, Any]] = {}
    polylines = set(port.ids(_abi.ELEMENT_POLYLINE_3D))
    linesets = set(port.ids(_abi.ELEMENT_LINE_SET))
    columns: list[dict[str, Any]] = []
    # The field id as the project stores it, by column.  Matching uses the
    # logical id (merge namespace removed) while resource lookups -- categories,
    # units, display names -- need the stored one.
    raw_field_by_column: dict[str, str] = {}
    for column_id in port.ids(_abi.ELEMENT_ATTRIBUTE):
        info = port.attribute_info(column_id)
        raw_field = port.attribute_field_id(column_id)
        raw_field_by_column[column_id] = raw_field
        columns.append({
            "id": column_id,
            "location": int(info.location),
            "element": port.attribute_element_id(column_id),
            "geometry": port.attribute_geometry_id(column_id),
            "field": _logical_field_id(raw_field),
        })
    by_element: dict[tuple[str, str, int], str] = {}
    by_geometry: dict[tuple[str, str, int], str] = {}
    for column in columns:
        key = (column["field"], column["location"])
        if column["location"] == _abi.LOCATION_ELEMENT:
            by_element[(column["element"],) + key] = column["id"]
        elif column["geometry"]:
            by_geometry[(column["geometry"],) + key] = column["id"]
    value_cache: dict[str, list[Any]] = {}

    def values(column_id: str) -> list[Any]:
        if column_id not in value_cache:
            value_cache[column_id] = port.attribute_values(column_id)
        return value_cache[column_id]

    def geometry_column(geometry_id: str, field_id: str, location: int) -> str | None:
        return by_geometry.get((geometry_id, field_id, location))

    def element_column(element_id: str, field_id: str) -> str | None:
        return by_element.get((element_id, field_id, _abi.LOCATION_ELEMENT))

    holes: list[dict[str, Any]] = []
    component_fields: dict[str, str] = {}
    for element_id in port.ids(_abi.ELEMENT_FEATURE):
        geometry_ids = port.element_geometry_ids(element_id)
        trace_id = None
        for geometry_id in geometry_ids:
            if geometry_id in polylines and \
                    geometry_column(geometry_id, _DRILL_TOTAL_DEPTH, _LOCATION_GEOMETRY):
                if trace_id is not None:
                    findings.append(Finding(
                        "warning", "export.multiple_traces",
                        "元素 %s 有多条钻孔轨迹，导出使用第一条" % element_id,
                        hole=port.element_name(element_id)))
                    break
                trace_id = geometry_id
        if trace_id is None:
            continue
        name = port.element_name(element_id)
        if not name:
            name = element_id
        total_column = geometry_column(trace_id, _DRILL_TOTAL_DEPTH, _LOCATION_GEOMETRY)
        total_values = values(total_column) if total_column else []
        if not total_values or total_values[0] is None:
            findings.append(Finding("warning", "export.no_total_depth",
                                    "%s 没有总深度，已跳过" % name, hole=name))
            continue
        points = port.read_points(_abi.ELEMENT_POLYLINE_3D, trace_id,
                                  project_coordinates=False)
        if not points:
            findings.append(Finding("warning", "export.no_trace",
                                    "%s 的轨迹没有顶点，已跳过" % name, hole=name))
            continue
        depth_column = geometry_column(trace_id, _DRILL_DEPTH, _LOCATION_VERTEX)
        azimuth_column = geometry_column(trace_id, _DRILL_AZIMUTH, _LOCATION_VERTEX)
        dip_column = geometry_column(trace_id, _DRILL_DIP, _LOCATION_VERTEX)
        depth_values = values(depth_column) if depth_column else []
        azimuth_values = values(azimuth_column) if azimuth_column else []
        dip_values = values(dip_column) if dip_column else []
        if not depth_column or not azimuth_column or not dip_column:
            findings.append(Finding("warning", "export.no_survey_columns",
                                    "%s 缺少测斜列，只导出孔口和总深度" % name, hole=name))
        survey_rows: list[SurveyRow] = []
        for index in range(len(points)):
            if index >= len(depth_values) or index >= len(azimuth_values) or \
                    index >= len(dip_values):
                break
            depth = depth_values[index]
            azimuth = azimuth_values[index]
            dip = dip_values[index]
            if azimuth is None and dip is None:
                # The collar before a first station deeper than zero, or the
                # extrapolated last vertex: neither is a measured station.
                continue
            if depth is None or azimuth is None or dip is None:
                findings.append(Finding("warning", "export.incomplete_station",
                                        "%s 的第 %d 个轨迹顶点缺少数值，已跳过"
                                        % (name, index), hole=name))
                continue
            survey_rows.append(SurveyRow(name, float(depth), float(azimuth),
                                         float(dip), 0))
        line_value = None
        line_column = element_column(element_id, _DRILL_LINE)
        if line_column:
            line = values(line_column)
            line_value = line[0] if line else None
            if line_value is not None and not isinstance(line_value, (int, str)):
                line_value = str(line_value)
        engineering_type = None
        engineering_column = element_column(element_id, _DRILL_ENGINEERING_TYPE)
        if engineering_column:
            engineering_values = values(engineering_column)
            if engineering_values and engineering_values[0] is not None:
                engineering_type = _export_category_name(
                    port,
                    raw_field_by_column.get(engineering_column,
                                            _DRILL_ENGINEERING_TYPE),
                    engineering_values[0], fields)
        sample_rows: list[SampleRow] = []
        lithology_rows: list[LithologyRow] = []
        for geometry_id in geometry_ids:
            if geometry_id not in linesets:
                continue
            kind_column = geometry_column(geometry_id, _INTERVAL_KIND, _LOCATION_GEOMETRY)
            if not kind_column:
                continue
            kind_values = values(kind_column)
            kind = kind_values[0] if kind_values else None
            from_column = geometry_column(geometry_id, _INTERVAL_FROM, _LOCATION_PART)
            to_column = geometry_column(geometry_id, _INTERVAL_TO, _LOCATION_PART)
            if not from_column or not to_column:
                findings.append(Finding("warning", "export.no_interval_columns",
                                        "%s 的一个区间集缺少 from/to 列，已跳过" % name,
                                        hole=name))
                continue
            froms = values(from_column)
            tos = values(to_column)
            count = min(len(froms), len(tos))
            if kind == _abi.DRILL_SAMPLE_INTERVAL:
                number_column = geometry_column(geometry_id, _SAMPLE_NUMBER, _LOCATION_PART)
                numbers = values(number_column) if number_column else []
                components: dict[str, list[Any]] = {}
                names: dict[str, str] = {}
                for (geometry, field, location), column_id in by_geometry.items():
                    if geometry != geometry_id or location != _LOCATION_PART or \
                            not field.startswith(_COMPONENT_PREFIX):
                        continue
                    field_value = _export_field(
                        port, raw_field_by_column.get(column_id, field), fields)
                    header = _logical_field_id(str(field_value.get("name") or ""))
                    if header.startswith(_COMPONENT_PREFIX):
                        # A project imported before the field's display name was
                        # separated from its id carries `component.TFe` as the
                        # name; the workbook header is the source column.  A
                        # merge prefix is removed first for the same reason.
                        header = header[len(_COMPONENT_PREFIX):]
                    if not header:
                        header = field[len(_COMPONENT_PREFIX):]
                    names[field] = header
                    components[field] = values(column_id)
                component_fields.update(names)
                for index in range(count):
                    if froms[index] is None or tos[index] is None:
                        findings.append(Finding("warning", "export.incomplete_interval",
                                                "%s 的第 %d 个样品缺少 from/to，已跳过"
                                                % (name, index), hole=name))
                        continue
                    component_values: dict[str, float | None] = {}
                    for field in names:
                        sequence = components[field]
                        component_values[field] = (float(sequence[index])
                                                   if index < len(sequence) and
                                                   sequence[index] is not None else None)
                    sample_rows.append(SampleRow(
                        name,
                        "" if index >= len(numbers) or numbers[index] is None
                        else str(numbers[index]),
                        float(froms[index]), float(tos[index]),
                        float(tos[index] - froms[index]),
                        component_values, 0))
            elif kind == _abi.DRILL_LITHOLOGY_INTERVAL:
                rock_column = geometry_column(geometry_id, _LITHOLOGY_ROCK, _LOCATION_PART)
                rocks = values(rock_column) if rock_column else []
                for index in range(count):
                    if froms[index] is None or tos[index] is None:
                        findings.append(Finding("warning", "export.incomplete_interval",
                                                "%s 的第 %d 个岩性区间缺少 from/to，已跳过"
                                                % (name, index), hole=name))
                        continue
                    rock = None
                    if index < len(rocks) and rocks[index] is not None:
                        rock = _export_category_name(
                            port, raw_field_by_column.get(rock_column, _LITHOLOGY_ROCK),
                            rocks[index], fields)
                    lithology_rows.append(LithologyRow(
                        name, float(froms[index]), float(tos[index]), rock or "", 0))
        metadata = port.element_metadata(element_id)
        source_row = None
        if metadata:
            try:
                decoded = json.loads(metadata)
                if isinstance(decoded, dict) and isinstance(decoded.get("source_row"), int):
                    source_row = decoded["source_row"]
            except ValueError:
                source_row = None
        holes.append({
            "name": name,
            "source_row": source_row,
            "east": float(points[0][0]),
            "north": float(points[0][1]),
            "elevation": float(points[0][2]),
            "total_depth": float(total_values[0]),
            "line": line_value,
            "engineering_type": engineering_type,
            "surveys": survey_rows,
            "samples": sample_rows,
            "lithologies": lithology_rows,
        })
    if not holes:
        raise ExplorationDataError("工程中没有找到探矿工程钻孔数据（没有带总深度的钻孔轨迹）")
    holes.sort(key=lambda hole: (hole["source_row"] if hole["source_row"] is not None
                                 else math.inf, hole["name"]))
    data = ExplorationData(source=project_name or "", sheets=dict(DEFAULT_SHEETS))
    for hole in holes:
        data.collars.append(Collar(
            hole["name"], hole["east"], hole["north"], hole["elevation"],
            hole["total_depth"], hole["line"], hole["engineering_type"], 0))
        data.surveys.extend(hole["surveys"])
        data.samples.extend(sorted(hole["samples"], key=lambda row: (row.from_depth,
                                                                    row.to_depth)))
        data.lithologies.extend(sorted(hole["lithologies"], key=lambda row: (row.from_depth,
                                                                            row.to_depth)))
    ordered_fields = sorted(component_fields,
                            key=lambda field: (component_fields[field], field))
    unique_names: dict[str, str] = {}
    used_names: set[str] = set()
    for field in ordered_fields:
        header = component_fields[field]
        if header in used_names:
            # The importer refuses duplicate component headers.  Append the
            # field id rather than dropping a column.
            header = "%s (%s)" % (header, field)
        used_names.add(header)
        unique_names[field] = header
    data.components = [unique_names[field] for field in ordered_fields]
    for row in data.samples:
        row.components = {unique_names[field]: value
                          for field, value in row.components.items()
                          if field in unique_names}
    for index, row in enumerate(data.collars):
        row.row = index + 2
    for index, row in enumerate(data.surveys):
        row.row = index + 2
    for index, row in enumerate(data.samples):
        row.row = index + 2
    for index, row in enumerate(data.lithologies):
        row.row = index + 2
    return data, findings


def export_exploration_data(project: str | Path | Port, output: str | Path, *,
                            library=None) -> ExportResult:
    """Exports the drilling resources of a Mining project to a four-sheet workbook.

    ``project`` is a .iam/.iamh path or a live Port.  The four sheets are the
    ones import_exploration_data() reads, so the result can be imported again.
    """
    destination = Path(output)
    project_name = str(project) if not isinstance(project, Port) else None
    try:
        if isinstance(project, Port):
            data, findings = read_exploration_project(project,
                                                      project_name=project_name)
            write_exploration_workbook(data, destination)
        else:
            from . import open as _open  # late: __init__ imports this module at the end
            with _open(project, library=library) as port:
                data, findings = read_exploration_project(port,
                                                          project_name=project_name)
                write_exploration_workbook(data, destination)
        counts = {
            "holes": len(data.collars),
            "survey_stations": len(data.surveys),
            "samples": len(data.samples),
            "lithology_intervals": len(data.lithologies),
            "components": list(data.components),
        }
        return ExportResult(True, project_name, destination, counts, findings)
    except (ExplorationDataError, IamError, OSError, ValueError) as error:
        return ExportResult(False, project_name, None, {}, [],
                            str(error))



# ---------------------------------------------------------------------------
# Convenience wrappers


def check_exploration_file(xlsx: str | Path, *, sheets: dict[str, str] | None = None,
                           component_columns: Sequence[str] | None = None,
                           units: dict[str, str] | None = None,
                           extrapolate: str = "last",
                           max_extrapolation: float = MAX_EXTRAPOLATION_DEFAULT,
                           max_sample_length: float = MAX_SAMPLE_LENGTH_DEFAULT,
                           max_dogleg_degrees: float = MAX_DOGLEG_DEFAULT
                           ) -> tuple[ExplorationData, list[Finding], dict[str, Any]]:
    """Reads and checks a workbook; writes nothing and changes nothing."""
    data = read_exploration_workbook(xlsx, sheets=sheets,
                                     component_columns=component_columns)
    findings = check_exploration_data(
        data, units=units, extrapolate=extrapolate,
        max_extrapolation=max_extrapolation, max_sample_length=max_sample_length,
        max_dogleg_degrees=max_dogleg_degrees)
    return data, findings, exploration_statistics(data, units=units)


def repair_exploration_file(xlsx: str | Path, repairs: Iterable[str] | None = None, *,
                            sheets: dict[str, str] | None = None,
                            component_columns: Sequence[str] | None = None,
                            units: dict[str, str] | None = None,
                            extrapolate: str = "last",
                            max_extrapolation: float = MAX_EXTRAPOLATION_DEFAULT,
                            max_sample_length: float = MAX_SAMPLE_LENGTH_DEFAULT,
                            max_dogleg_degrees: float = MAX_DOGLEG_DEFAULT
                            ) -> tuple[ExplorationData, list[Repair], list[Finding], dict[str, Any]]:
    """Reads, applies the named repairs (default: the safe set) and re-checks."""
    data = read_exploration_workbook(xlsx, sheets=sheets,
                                     component_columns=component_columns)
    repaired, applied = repair_exploration_data(data, repairs, units=units)
    findings = check_exploration_data(
        repaired, units=units, extrapolate=extrapolate,
        max_extrapolation=max_extrapolation, max_sample_length=max_sample_length,
        max_dogleg_degrees=max_dogleg_degrees)
    return repaired, applied, findings, exploration_statistics(repaired, units=units)


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="导入探矿工程 Excel（孔口/测斜/样品/岩性）到 Mining；"
                    "默认保持原样，可选修复并输出 QC / 修复报告。")
    parser.add_argument("xlsx")
    parser.add_argument("-o", "--output", help="输出 .iamh（默认与工作簿同名的 .iamh）")
    parser.add_argument("--report", help="QC 报告路径（默认 <输出>.qc.json）")
    parser.add_argument("--repair-report", help="修复报告路径（默认 <输出>.repair.json）")
    parser.add_argument("--unit", action="append", default=[],
                        help="矿物元素单位，例如 --unit TFe=%%")
    parser.add_argument("--repair", action="store_true", help="应用安全修复集")
    parser.add_argument("--repair-code", action="append", default=[],
                        help="指定修复项；可重复。可选: " + ", ".join(ALL_REPAIRS))
    parser.add_argument("--strict", action="store_true", help="警告也阻止导入")
    parser.add_argument("--extrapolate", choices=("last", "stop"), default="last")
    parser.add_argument("--max-extrapolation", type=float,
                        default=MAX_EXTRAPOLATION_DEFAULT)
    parser.add_argument("--max-sample-length", type=float,
                        default=MAX_SAMPLE_LENGTH_DEFAULT)
    parser.add_argument("--max-dogleg", type=float, default=MAX_DOGLEG_DEFAULT)
    parser.add_argument("--check-only", action="store_true",
                        help="只读取并检查，不创建工程")
    parser.add_argument("--no-save", action="store_true", help="构建但不写出工程")
    arguments = parser.parse_args(argv)
    units = _unit_overrides(arguments.unit)
    try:
        if arguments.check_only:
            applied: list[Repair] = []
            if arguments.repair_code or arguments.repair:
                codes = tuple(arguments.repair_code) if arguments.repair_code else None
                data, applied, findings, statistics = repair_exploration_file(
                    arguments.xlsx, codes, units=units,
                    extrapolate=arguments.extrapolate,
                    max_extrapolation=arguments.max_extrapolation,
                    max_sample_length=arguments.max_sample_length,
                    max_dogleg_degrees=arguments.max_dogleg)
            else:
                data, findings, statistics = check_exploration_file(
                    arguments.xlsx, units=units, extrapolate=arguments.extrapolate,
                    max_extrapolation=arguments.max_extrapolation,
                    max_sample_length=arguments.max_sample_length,
                    max_dogleg_degrees=arguments.max_dogleg)
            ordered, summary = _report_findings(findings)
            report = Path(arguments.report) if arguments.report else \
                Path(arguments.xlsx).with_suffix(".qc.json")
            repair_report = Path(arguments.repair_report) if arguments.repair_report else \
                Path(arguments.xlsx).with_suffix(".repair.json")
            _write_json(report, {
                "source": str(arguments.xlsx), "generated": _now(),
                "qualified": summary["errors"] == 0, "strict": arguments.strict,
                "blocked": summary["errors"] > 0 or
                (arguments.strict and summary["warnings"] > 0),
                "counts": statistics["counts"], "statistics": statistics,
                "findings": ordered, "summary": summary,
                "repairs_applied": len(applied),
            })
            _write_json(repair_report, {
                "source": str(arguments.xlsx), "generated": _now(),
                "applied": [item.to_dict() for item in applied],
                "summary": {"repairs": len(applied)},
                "post_repair_summary": summary,
                "note": ("未启用修复" if not applied else
                         "修复只包含调用方指定的项"),
            })
            _print_summary(statistics, summary, report, None)
            print("修复报告: %s" % repair_report)
            return 0 if summary["errors"] == 0 else 1
        repairs: bool | tuple[str, ...] = False
        if arguments.repair_code:
            repairs = tuple(arguments.repair_code)
        elif arguments.repair:
            repairs = True
        result = import_exploration_data(
            arguments.xlsx, arguments.output, units=units,
            extrapolate=arguments.extrapolate,
            max_extrapolation=arguments.max_extrapolation,
            max_sample_length=arguments.max_sample_length,
            max_dogleg_degrees=arguments.max_dogleg,
            repair=repairs, strict=arguments.strict,
            report_path=arguments.report, repair_report_path=arguments.repair_report,
            save=not arguments.no_save)
        summary = {"errors": sum(1 for item in result.findings if item.severity == "error"),
                   "warnings": sum(1 for item in result.findings if item.severity == "warning"),
                   "infos": sum(1 for item in result.findings if item.severity == "info")}
        _print_summary(result.statistics, summary, result.reports["qc"],
                       result.output)
        print("修复报告: %s" % result.reports["repair"])
        if result.port is not None:
            result.port.close()
        if result.error:
            print("未导入: %s" % result.error)
        return 0 if result.ok else 1
    except (ExplorationDataError, IamError, ValueError) as error:
        print("错误: %s" % error)
        return 2


def _print_summary(statistics: dict[str, Any], summary: dict[str, int],
                   report: Path | None, output: Path | None) -> None:
    counts = statistics.get("counts", {})
    print("孔 %s，测斜站 %s，样品 %s，岩性 %s" % (
        counts.get("holes", "?"), counts.get("survey_stations", "?"),
        counts.get("samples", "?"), counts.get("lithology_intervals", "?")))
    print("检查: %d 错误，%d 警告，%d 提示" % (
        summary["errors"], summary["warnings"], summary["infos"]))
    if report:
        print("QC 报告: %s" % report)
    if output:
        print("已写入: %s" % output)


if __name__ == "__main__":
    raise SystemExit(main())
