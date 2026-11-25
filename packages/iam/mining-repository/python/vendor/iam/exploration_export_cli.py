"""Command line for exporting a Mining project's exploration drilling data.

This is the reverse of ``iam.exploration_cli``: the four sheets are the ones that
importer reads, so the exported workbook can be edited and imported again.
"""

from .exploration import export_exploration_data


def main(argv=None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="从 Mining 工程导出探矿工程四表工作簿（孔口/测斜/样品/岩性）")
    parser.add_argument("project", help="工程文件路径（.iam 或 .iamh）")
    parser.add_argument("-o", "--output", required=True, help="输出 .xlsx 路径")
    arguments = parser.parse_args(argv)
    result = export_exploration_data(arguments.project, arguments.output)
    if not result.ok:
        print("导出失败: %s" % (result.error or "未知错误"))
        return 2
    counts = result.counts
    print("孔 %d，测斜站 %d，样品 %d，岩性 %d -> %s" % (
        counts["holes"], counts["survey_stations"], counts["samples"],
        counts["lithology_intervals"], result.output))
    for finding in result.findings:
        print("%s %s: %s" % (finding.severity, finding.code, finding.message))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
