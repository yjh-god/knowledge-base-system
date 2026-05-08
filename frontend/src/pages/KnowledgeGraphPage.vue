<template>
    <div class="kg-page">
        <div class="kg-merged-panel">
            <el-tabs v-model="activeTab" type="border-card" class="kg-tabs kg-tabs--in-panel" @tab-change="onKgTabChange">
            <el-tab-pane label="双层图谱" name="double-layer-kg">
                <!-- 第一层：中心「知识库」+ 文件名分支力导图；左侧全库知识点检索 → 关联文件 → 点击进入第二层 -->
                <div v-if="!selectedKgDocId" class="kg-layer-hub">
                    <p class="kg-graph-intro">
                        <strong>第一层</strong>：与「交互图谱」同为力导图——<strong>知识库</strong>在中心，外围分支为各<strong>文件名</strong>。<strong>双击</strong>某个文件名节点进入<strong>第二层</strong>（该文件内的交互图谱）。<strong>最左侧</strong>可按知识点检索全库实体，结果会列出<strong>与之关联的文件名</strong>，点击某一文件即可跳转到该文件的第二层图谱。
                    </p>
                    <el-row :gutter="12" class="kg-split-row kg-layer-hub-row">
                        <el-col :xs="24" :sm="8" :md="6" :lg="5" class="kg-search-panel">
                            <div class="kg-search-panel-inner">
                                <div class="kg-search-title">知识点检索（全库）</div>
                                <el-input
                                    v-model="layer1EntitySearchQ"
                                    placeholder="实体 / 知识点名称"
                                    clearable
                                    @keyup.enter="runLayer1EntitySearch"
                                    @clear="clearLayer1EntitySearch"
                                >
                                    <template #append>
                                        <el-button
                                            :loading="layer1EntitySearchLoading"
                                            @click="runLayer1EntitySearch"
                                        >
                                            搜索
                                        </el-button>
                                    </template>
                                </el-input>
                                <el-scrollbar class="kg-search-scroll">
                                    <div
                                        v-for="g in layer1SearchFileGroups"
                                        :key="g.docId"
                                        class="kg-search-hit kg-layer1-file-hit"
                                        @click="openFileFromLayer1Search(g)"
                                    >
                                        <div class="kg-search-hit-name">{{ g.fileTitle }}</div>
                                        <div class="kg-search-hit-meta">
                                            匹配知识点：
                                            {{
                                                g.matches
                                                    .slice(0, 4)
                                                    .map((m) => m.entityName)
                                                    .join("、")
                                            }}
                                            <template v-if="g.matches.length > 4"> 等</template>
                                        </div>
                                    </div>
                                    <el-empty
                                        v-if="
                                            layer1SearchRan &&
                                            !layer1EntitySearchLoading &&
                                            layer1SearchFileGroups.length === 0
                                        "
                                        description="无匹配或未抽取实体"
                                        :image-size="64"
                                    />
                                </el-scrollbar>
                            </div>
                        </el-col>
                        <el-col :xs="24" :sm="16" :md="18" :lg="19" class="kg-graph-panel">
                            <div class="kg-toolbar kg-toolbar--hub">
                                <el-button :icon="Refresh" :loading="kgHubLoading" @click="loadKgHubGraph">
                                    刷新总览
                                </el-button>
                                <span class="kg-toolbar-hint">
                                    提示：在右侧图中<strong>双击</strong>文件名节点（非中心「知识库」）进入该文件的第二层交互图谱。
                                </span>
                            </div>
                            <el-alert
                                v-if="kgHubTruncated"
                                type="info"
                                show-icon
                                :closable="false"
                                class="kg-graph-alert"
                                :title="
                                    '分支最多展示 ' +
                                    kgHubLimit +
                                    ' 个文件（知识库共 ' +
                                    kgHubDocTotal +
                                    ' 个文档）。'
                                "
                            />
                            <div
                                v-loading="kgHubLoading"
                                class="kg-graph-wrap kg-graph-wrap-split kg-graph-wrap--hub"
                            >
                                <el-empty
                                    v-if="showKgHubEmpty"
                                    description="暂无文档，请先上传或同步入库"
                                />
                                <div
                                    v-show="!showKgHubEmpty"
                                    ref="kgHubGraphRef"
                                    class="kg-echarts-graph"
                                />
                            </div>
                        </el-col>
                    </el-row>
                </div>

                <!-- 第二层：单文档 + 左侧检索 + 右侧力导图 -->
                <div v-else class="kg-layer-graph">
                    <div class="kg-doc-nav">
                        <el-button :icon="Refresh" text type="primary" @click="backToKgDocList">
                            ← 返回第一层（知识库总览）
                        </el-button>
                        <span class="kg-doc-nav-title">{{ selectedKgDocTitle }}</span>
                    </div>
                    <p class="kg-graph-intro">
                        <strong>第二层</strong>：最左侧为实体检索；右侧为力导图，可<strong>拖拽节点</strong>、<strong>滚轮缩放</strong>、<strong>拖动画布</strong>平移。在检索结果上点击可在图中聚焦该节点。
                    </p>
                    <el-row :gutter="12" class="kg-split-row">
                        <el-col :xs="24" :sm="8" :md="6" :lg="5" class="kg-search-panel">
                            <div class="kg-search-panel-inner">
                                <div class="kg-search-title">实体检索（最左侧）</div>
                                <el-input
                                    v-model="entitySearchQ"
                                    placeholder="实体名称关键字"
                                    clearable
                                    @keyup.enter="runKgEntitySearch"
                                    @clear="onEntitySearchClear"
                                >
                                    <template #append>
                                        <el-button :loading="entitySearchLoading" @click="runKgEntitySearch">
                                            搜索
                                        </el-button>
                                    </template>
                                </el-input>
                                <el-scrollbar class="kg-search-scroll">
                                    <div
                                        v-for="r in entitySearchResults"
                                        :key="r.id"
                                        class="kg-search-hit"
                                        @click="focusKgEntityOnGraph(r.id)"
                                    >
                                        <div class="kg-search-hit-name">{{ r.name }}</div>
                                        <div class="kg-search-hit-meta">
                                            {{ r.entityTypeCode }}
                                            <template v-if="r.sourceChunkIndex != null">
                                                · 块 {{ r.sourceChunkIndex }}
                                            </template>
                                        </div>
                                    </div>
                                    <el-empty
                                        v-if="entitySearchRan && !entitySearchLoading && entitySearchResults.length === 0"
                                        description="无匹配实体"
                                        :image-size="64"
                                    />
                                </el-scrollbar>
                            </div>
                        </el-col>
                        <el-col :xs="24" :sm="16" :md="18" :lg="19" class="kg-graph-panel">
                            <div class="kg-toolbar">
                                <el-button :icon="Refresh" :loading="kgGraphLoading" @click="loadKgDocGraph">
                                    刷新图谱
                                </el-button>
                            </div>
                            <el-alert
                                v-if="kgGraphTruncated"
                                type="info"
                                show-icon
                                :closable="false"
                                class="kg-graph-alert"
                                :title="
                                    '仅展示最近 ' +
                                    kgGraphLimit +
                                    ' 条边（当前文档内共 ' +
                                    kgGraphEdgeTotal +
                                    ' 条）。'
                                "
                            />
                            <div v-loading="kgGraphLoading" class="kg-graph-wrap kg-graph-wrap-split">
                                <el-empty v-if="showKgGraphEmpty" description="该文档暂无关系边或尚未抽取" />
                                <div v-show="!showKgGraphEmpty" ref="kgDocGraphRef" class="kg-echarts-graph" />
                            </div>
                        </el-col>
                    </el-row>
                </div>
            </el-tab-pane>

            <el-tab-pane label="交互图谱" name="interactive-graph" lazy>
                <p class="kg-graph-intro">
                    全库关系子图：展示最近一批边及其端点实体，可<strong>拖拽节点</strong>、<strong>滚轮缩放</strong>、<strong>拖动画布</strong>平移（与原先全库交互一致）。
                </p>
                <div class="kg-toolbar">
                    <el-button :icon="Refresh" :loading="kgGlobalGraphLoading" @click="loadKgGlobalGraph">
                        刷新图谱
                    </el-button>
                </div>
                <el-alert
                    v-if="kgGlobalGraphTruncated"
                    type="info"
                    show-icon
                    :closable="false"
                    class="kg-graph-alert"
                    :title="
                        '仅展示最近 ' +
                        kgGlobalGraphLimit +
                        ' 条边（全库共 ' +
                        kgGlobalGraphEdgeTotal +
                        ' 条）。'
                    "
                />
                <div v-loading="kgGlobalGraphLoading" class="kg-graph-wrap">
                    <el-empty v-if="showKgGlobalGraphEmpty" description="暂无关系边或尚未抽取图谱" />
                    <div v-show="!showKgGlobalGraphEmpty" ref="kgGlobalGraphRef" class="kg-echarts-graph" />
                </div>
            </el-tab-pane>

            <el-tab-pane label="数据概览" name="overview">
                <el-row :gutter="16" class="kg-stat-row">
                    <el-col :xs="12" :sm="6">
                        <el-card shadow="hover" class="kg-stat-card">
                            <div class="kg-stat-num">{{ summary.entityCount }}</div>
                            <div class="kg-stat-label">实体实例</div>
                        </el-card>
                    </el-col>
                    <el-col :xs="12" :sm="6">
                        <el-card shadow="hover" class="kg-stat-card">
                            <div class="kg-stat-num">{{ summary.edgeCount }}</div>
                            <div class="kg-stat-label">关系边</div>
                        </el-card>
                    </el-col>
                    <el-col :xs="12" :sm="6">
                        <el-card shadow="hover" class="kg-stat-card">
                            <div class="kg-stat-num">{{ summary.entityTypeCount }}</div>
                            <div class="kg-stat-label">实体类型</div>
                        </el-card>
                    </el-col>
                    <el-col :xs="12" :sm="6">
                        <el-card shadow="hover" class="kg-stat-card">
                            <div class="kg-stat-num">{{ summary.relationTypeCount }}</div>
                            <div class="kg-stat-label">关系类型</div>
                        </el-card>
                    </el-col>
                </el-row>
                <p class="kg-overview-line">
                    <strong>已确认保留</strong>四类关系：
                    <el-tag
                        v-for="c in summary.relationTypesKept"
                        :key="c"
                        class="kg-tag-gap"
                        type="primary"
                        effect="plain"
                        size="small"
                        >{{ c }}</el-tag
                    >
                    （引用 / 属于 / 适用于 / 替代）
                </p>
                <el-button :icon="Refresh" @click="loadSummary">刷新统计</el-button>
            </el-tab-pane>

            <el-tab-pane label="实体实例" name="entity-instances" lazy>
                <div class="kg-toolbar">
                    <el-button type="primary" :icon="Plus" @click="openEntityInstDialog">新增实体</el-button>
                    <el-button :icon="Refresh" @click="loadEntityInstances">刷新</el-button>
                </div>
                <el-table v-loading="entityInstLoading" :data="entityInstRows" stripe border class="kg-table">
                    <el-table-column prop="entityTypeCode" label="类型 code" width="140" />
                    <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
                    <el-table-column prop="sourceDocId" label="来源文档 ID" width="200" show-overflow-tooltip />
                    <el-table-column prop="sourceChunkIndex" label="块序号" width="88" align="center" />
                    <el-table-column prop="createdAt" label="创建时间" width="168" />
                    <el-table-column label="操作" width="100" fixed="right">
                        <template #default="{ row }">
                            <el-button type="danger" link size="small" @click="deleteEntityInst(row)">
                                删除
                            </el-button>
                        </template>
                    </el-table-column>
                </el-table>
                <div class="kg-pager">
                    <el-pagination
                        v-model:current-page="entityInstPage"
                        v-model:page-size="entityInstPageSize"
                        :total="entityInstTotal"
                        :page-sizes="[10, 20, 50]"
                        layout="total, sizes, prev, pager, next"
                        @current-change="loadEntityInstances"
                        @size-change="onEntityInstSizeChange"
                    />
                </div>
            </el-tab-pane>

            <el-tab-pane label="关系实例" name="edge-instances" lazy>
                <div class="kg-toolbar">
                    <el-button type="primary" :icon="Plus" @click="openEdgeDlg">新增关系边</el-button>
                    <el-button :icon="Refresh" @click="loadEdgeInstances">刷新</el-button>
                </div>
                <el-table v-loading="edgeInstLoading" :data="edgeInstRows" stripe border class="kg-table">
                    <el-table-column prop="relationTypeCode" label="关系" width="120" />
                    <el-table-column label="头实体" min-width="200" show-overflow-tooltip>
                        <template #default="{ row }">
                            <span class="kg-cell-strong">{{ row.fromName }}</span>
                            <span class="kg-cell-sub">（{{ row.fromEntityTypeCode }}）</span>
                        </template>
                    </el-table-column>
                    <el-table-column label="尾实体" min-width="200" show-overflow-tooltip>
                        <template #default="{ row }">
                            <span class="kg-cell-strong">{{ row.toName }}</span>
                            <span class="kg-cell-sub">（{{ row.toEntityTypeCode }}）</span>
                        </template>
                    </el-table-column>
                    <el-table-column prop="confidence" label="置信度" width="88" align="center" />
                    <el-table-column prop="createdAt" label="创建时间" width="168" />
                    <el-table-column label="操作" width="100" fixed="right">
                        <template #default="{ row }">
                            <el-button type="danger" link size="small" @click="deleteEdgeInst(row)">
                                删除
                            </el-button>
                        </template>
                    </el-table-column>
                </el-table>
                <div class="kg-pager">
                    <el-pagination
                        v-model:current-page="edgeInstPage"
                        v-model:page-size="edgeInstPageSize"
                        :total="edgeInstTotal"
                        :page-sizes="[10, 20, 50]"
                        layout="total, sizes, prev, pager, next"
                        @current-change="loadEdgeInstances"
                        @size-change="onEdgeInstSizeChange"
                    />
                </div>
            </el-tab-pane>

            <el-tab-pane label="实体类型定义" name="entities">
                <div class="kg-toolbar">
                    <el-button type="primary" :icon="Plus" @click="openEntityDialog">新增实体类型</el-button>
                    <el-button :icon="Refresh" @click="loadEntityTypes">刷新</el-button>
                </div>
                <el-table v-loading="entityLoading" :data="entityRows" stripe border class="kg-table">
                    <el-table-column prop="code" label="编码 code" width="160" />
                    <el-table-column prop="displayName" label="显示名称" min-width="140" />
                    <el-table-column prop="description" label="说明" min-width="220" show-overflow-tooltip />
                    <el-table-column prop="sortOrder" label="排序" width="72" align="center" />
                    <el-table-column label="启用" width="80" align="center">
                        <template #default="{ row }">
                            <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                                {{ row.isActive ? "是" : "否" }}
                            </el-tag>
                        </template>
                    </el-table-column>
                </el-table>
            </el-tab-pane>

            <el-tab-pane label="关系类型定义" name="relations">
                <div class="kg-toolbar">
                    <el-button type="primary" :icon="Plus" @click="openRelationDialog">新增关系类型</el-button>
                    <el-button :icon="Refresh" @click="loadRelationTypes">刷新</el-button>
                </div>
                <p class="kg-hint">
                    <strong>已确认保留四类关系</strong>（<code>references</code> / <code>belongs_to</code> /
                    <code>applies_to</code> / <code>supersedes</code>）。三元组方向为「头实体 — 关系 — 尾实体」；
                    <code>domain</code>/<code>range</code> 为可选约束，建边时后端会校验与实体类型一致。
                </p>
                <el-table v-loading="relationLoading" :data="relationRows" stripe border class="kg-table">
                    <el-table-column prop="code" label="编码 code" width="140" />
                    <el-table-column prop="displayName" label="显示名称" min-width="120" />
                    <el-table-column prop="description" label="说明" min-width="200" show-overflow-tooltip />
                    <el-table-column prop="domainTypeCode" label="域 domain" width="130" show-overflow-tooltip />
                    <el-table-column prop="rangeTypeCode" label="值域 range" width="130" show-overflow-tooltip />
                    <el-table-column prop="sortOrder" label="排序" width="72" align="center" />
                </el-table>
            </el-tab-pane>

            <el-tab-pane label="块节点 Payload 字段" name="payload">
                <el-descriptions title="Qdrant 每点附加字段（与上传元数据对应）" :column="1" border>
                    <el-descriptions-item label="content">文本块摘录（长度受 INGEST_KG_CHUNK_TEXT_MAX 控制）</el-descriptions-item>
                    <el-descriptions-item label="doc_id">文档唯一 ID</el-descriptions-item>
                    <el-descriptions-item label="title">文档标题</el-descriptions-item>
                    <el-descriptions-item label="chunk_index">分块序号</el-descriptions-item>
                    <el-descriptions-item label="source">来源文件路径或 source_uri</el-descriptions-item>
                    <el-descriptions-item label="department">所属部门展示或可见部门 id</el-descriptions-item>
                    <el-descriptions-item label="create_time">文档创建时间</el-descriptions-item>
                    <el-descriptions-item label="author / version">作者、版本号</el-descriptions-item>
                    <el-descriptions-item label="knowledge_type">FAQ | 制度 | 方案 | 文档</el-descriptions-item>
                    <el-descriptions-item label="node_kind">固定为 chunk</el-descriptions-item>
                </el-descriptions>
            </el-tab-pane>

            <el-tab-pane label="说明" name="kg-readme" lazy>
                <div class="kg-readme-wrap">
                    <h1 class="kg-title">知识图谱 · 本体与块节点</h1>
                    <p class="kg-sub">
                        业务实体类型与关系类型由管理员配置。<strong>双层图谱</strong>第一层为力导图：中心<strong>知识库</strong>、分支为<strong>文件名</strong>，双击文件名进入该文件图谱；最左侧可检索知识点并按<strong>关联文件</strong>跳转。第二栏<strong>交互图谱</strong>为全库关系子图。
                        每个向量块在 Qdrant 中带
                        <code>doc_id</code>、<code>content</code>、<code>title</code>、<code>knowledge_type</code>
                        等字段，便于后续抽取边与可视化。
                    </p>
                    <div class="kg-readme-meta">
                        <el-tag type="success" effect="light" size="small">已连接后端 /admin/kg/*</el-tag>
                        <span class="kg-readme-version-badge">知识库 · KG v0.2</span>
                    </div>
                </div>
            </el-tab-pane>
        </el-tabs>
        </div>

        <el-dialog v-model="entityDlg" title="新增实体类型" width="480px" destroy-on-close @closed="resetEntityForm">
            <el-form :model="entityForm" label-width="100px">
                <el-form-item label="code" required>
                    <el-input v-model="entityForm.code" placeholder="英文编码，如 MyEntity" />
                </el-form-item>
                <el-form-item label="显示名称" required>
                    <el-input v-model="entityForm.displayName" placeholder="中文名称" />
                </el-form-item>
                <el-form-item label="说明">
                    <el-input v-model="entityForm.description" type="textarea" rows="2" />
                </el-form-item>
                <el-form-item label="排序">
                    <el-input-number v-model="entityForm.sortOrder" :min="0" :max="9999" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="entityDlg = false">取消</el-button>
                <el-button type="primary" :loading="entitySaving" @click="submitEntity">保存</el-button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="entityInstDlg"
            title="新增实体实例"
            width="520px"
            destroy-on-close
            @closed="resetEntityInstForm"
        >
            <el-form :model="entityInstForm" label-width="120px">
                <el-form-item label="实体类型" required>
                    <el-select v-model="entityInstForm.entityTypeCode" placeholder="选择类型" filterable>
                        <el-option
                            v-for="t in activeEntityTypes"
                            :key="t.code"
                            :label="`${t.displayName} (${t.code})`"
                            :value="t.code"
                        />
                    </el-select>
                </el-form-item>
                <el-form-item label="名称" required>
                    <el-input v-model="entityInstForm.name" placeholder="业务可见名称" />
                </el-form-item>
                <el-form-item label="扩展 JSON">
                    <el-input
                        v-model="entityInstForm.propertiesJson"
                        type="textarea"
                        :rows="3"
                        placeholder='可选，如 {"clauseId":"3.2"}'
                    />
                </el-form-item>
                <el-form-item label="来源文档 ID">
                    <el-input v-model="entityInstForm.sourceDocId" placeholder="可选 UUID" />
                </el-form-item>
                <el-form-item label="来源块序号">
                    <el-input-number v-model="entityInstForm.sourceChunkIndex" :min="0" :max="999999" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="entityInstDlg = false">取消</el-button>
                <el-button type="primary" :loading="entityInstSaving" @click="submitEntityInst">保存</el-button>
            </template>
        </el-dialog>

        <el-dialog
            v-model="edgeDlg"
            title="新增关系边"
            width="560px"
            destroy-on-close
            @open="loadEntityPickerList"
            @closed="resetEdgeForm"
        >
            <el-form :model="edgeForm" label-width="120px">
                <el-form-item label="关系类型" required>
                    <el-select v-model="edgeForm.relationTypeCode" placeholder="四类之一">
                        <el-option label="references（引用）" value="references" />
                        <el-option label="belongs_to（属于）" value="belongs_to" />
                        <el-option label="applies_to（适用于）" value="applies_to" />
                        <el-option label="supersedes（替代）" value="supersedes" />
                    </el-select>
                </el-form-item>
                <el-form-item label="头实体" required>
                    <el-select
                        v-model="edgeForm.fromEntityId"
                        filterable
                        placeholder="选择头实体"
                        style="width: 100%"
                    >
                        <el-option
                            v-for="e in entityPickerList"
                            :key="e.id"
                            :label="`${e.name} (${e.entityTypeCode})`"
                            :value="e.id"
                        />
                    </el-select>
                </el-form-item>
                <el-form-item label="尾实体" required>
                    <el-select
                        v-model="edgeForm.toEntityId"
                        filterable
                        placeholder="选择尾实体"
                        style="width: 100%"
                    >
                        <el-option
                            v-for="e in entityPickerList"
                            :key="'t-' + e.id"
                            :label="`${e.name} (${e.entityTypeCode})`"
                            :value="e.id"
                        />
                    </el-select>
                </el-form-item>
                <el-form-item label="来源文档 ID">
                    <el-input v-model="edgeForm.sourceDocId" placeholder="可选" />
                </el-form-item>
                <el-form-item label="置信度 0~1">
                    <el-input-number v-model="edgeForm.confidence" :min="0" :max="1" :step="0.05" :precision="2" />
                </el-form-item>
                <el-form-item label="扩展 JSON">
                    <el-input v-model="edgeForm.propertiesJson" type="textarea" :rows="2" placeholder="可选" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="edgeDlg = false">取消</el-button>
                <el-button type="primary" :loading="edgeSaving" @click="submitEdge">保存</el-button>
            </template>
        </el-dialog>

        <el-dialog v-model="relationDlg" title="新增关系类型" width="520px" destroy-on-close @closed="resetRelationForm">
            <el-form :model="relationForm" label-width="120px">
                <el-form-item label="code" required>
                    <el-input v-model="relationForm.code" placeholder="如 governs" />
                </el-form-item>
                <el-form-item label="显示名称" required>
                    <el-input v-model="relationForm.displayName" placeholder="中文关系名" />
                </el-form-item>
                <el-form-item label="说明">
                    <el-input v-model="relationForm.description" type="textarea" rows="2" />
                </el-form-item>
                <el-form-item label="域实体 code">
                    <el-input v-model="relationForm.domainTypeCode" placeholder="可选，如 DocumentChunk" />
                </el-form-item>
                <el-form-item label="值域实体 code">
                    <el-input v-model="relationForm.rangeTypeCode" placeholder="可选，如 Department" />
                </el-form-item>
                <el-form-item label="排序">
                    <el-input-number v-model="relationForm.sortOrder" :min="0" :max="9999" />
                </el-form-item>
            </el-form>
            <template #footer>
                <el-button @click="relationDlg = false">取消</el-button>
                <el-button type="primary" :loading="relationSaving" @click="submitRelation">保存</el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup>
import * as echarts from "echarts";
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { Plus, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../lib/api";

const kgDocGraphRef = ref(null);
const kgHubGraphRef = ref(null);
const kgGlobalGraphRef = ref(null);
const kgGraphLoading = ref(false);
const kgGraphFetched = ref(false);
const kgGraphNodeCount = ref(0);
const kgGraphTruncated = ref(false);
const kgGraphLimit = ref(500);
const kgGraphEdgeTotal = ref(0);
/** 全库交互图谱（第二栏） */
const kgGlobalGraphLoading = ref(false);
const kgGlobalGraphFetched = ref(false);
const kgGlobalGraphNodeCount = ref(0);
const kgGlobalGraphTruncated = ref(false);
const kgGlobalGraphLimit = ref(500);
const kgGlobalGraphEdgeTotal = ref(0);
/** 双层图谱：当前选中的来源文档 */
const selectedKgDocId = ref(null);
const selectedKgDocTitle = ref("");
/** 第一层：知识库总览力导图 */
const kgHubLoading = ref(false);
const kgHubFetched = ref(false);
const kgHubTruncated = ref(false);
const kgHubLimit = ref(400);
const kgHubDocTotal = ref(0);
const kgHubDocCount = ref(0);
/** 第一层左侧：全库实体检索 → 按文件聚合 */
const layer1EntitySearchQ = ref("");
const layer1EntitySearchLoading = ref(false);
const layer1SearchFileGroups = ref([]);
const layer1SearchRan = ref(false);
const entitySearchQ = ref("");
const entitySearchLoading = ref(false);
const entitySearchResults = ref([]);
const entitySearchRan = ref(false);
/** 当前图中节点顺序（与 ECharts series.data 一致，用于检索定位） */
const kgLastGraphNodes = ref([]);
/** @type {import("echarts").EChartsType | null} */
let kgDocChart = null;
/** @type {import("echarts").EChartsType | null} */
let kgHubChart = null;
/** @type {import("echarts").EChartsType | null} */
let kgGlobalChart = null;
/** @type {((p: unknown) => void) | null} */
let kgHubDblClickHandler = null;

const KB_ROOT_ID = "__kb_root__";

const showKgGraphEmpty = computed(
    () => kgGraphFetched.value && !kgGraphLoading.value && kgGraphNodeCount.value === 0
);

const showKgGlobalGraphEmpty = computed(
    () =>
        kgGlobalGraphFetched.value &&
        !kgGlobalGraphLoading.value &&
        kgGlobalGraphNodeCount.value === 0
);

const showKgHubEmpty = computed(
    () => kgHubFetched.value && !kgHubLoading.value && kgHubDocCount.value === 0
);

const KG_TYPE_ORDER = ["DocumentChunk", "FAQ", "Policy", "Department"];
const graphCategories = [
    { name: "DocumentChunk", itemStyle: { color: "#409eff" } },
    { name: "FAQ", itemStyle: { color: "#f56c6c" } },
    { name: "Policy", itemStyle: { color: "#67c23a" } },
    { name: "Department", itemStyle: { color: "#e6a23c" } },
    { name: "其他", itemStyle: { color: "#909399" } }
];

const entityTypeToCategoryIndex = (code) => {
    const i = KG_TYPE_ORDER.indexOf(String(code || ""));
    return i >= 0 ? i : KG_TYPE_ORDER.length;
};

const resizeKgGraph = () => {
    kgDocChart?.resize();
    kgHubChart?.resize();
    kgGlobalChart?.resize();
};

const disposeKgDocChart = () => {
    kgDocChart?.dispose();
    kgDocChart = null;
};

const disposeKgHubChart = () => {
    if (kgHubChart && kgHubDblClickHandler) {
        try {
            kgHubChart.off("dblclick", kgHubDblClickHandler);
        } catch (_) {
            /* ignore */
        }
        kgHubDblClickHandler = null;
    }
    kgHubChart?.dispose();
    kgHubChart = null;
};

const disposeKgGlobalChart = () => {
    kgGlobalChart?.dispose();
    kgGlobalChart = null;
};

const disposeAllKgCharts = () => {
    disposeKgDocChart();
    disposeKgHubChart();
    disposeKgGlobalChart();
};

const buildKgForceGraphOption = (nodes, links) => ({
    tooltip: {
        trigger: "item",
        formatter: (p) => {
            if (p.dataType === "edge") {
                const l = p.data || {};
                return `${l.relationDisplay || ""}<br/>${l.source} → ${l.target}`;
            }
            const n = p.data || {};
            return `${n.fullName || n.name || ""}<br/>类型：${n.entityType || ""}<br/>id：${n.id || ""}`;
        }
    },
    legend: {
        data: graphCategories.map((c) => c.name),
        bottom: 0,
        left: "center"
    },
    series: [
        {
            type: "graph",
            layout: "force",
            roam: true,
            draggable: true,
            categories: graphCategories,
            data: nodes.map((n) => {
                const fullName = String(n.name || "");
                const short = fullName.length > 24 ? `${fullName.slice(0, 22)}…` : fullName;
                const t = String(n.entityTypeCode || "");
                return {
                    id: n.id,
                    name: short,
                    fullName,
                    entityType: t,
                    category: entityTypeToCategoryIndex(t),
                    symbolSize: t === "DocumentChunk" ? 26 : 20,
                    label: { show: true, fontSize: 11 }
                };
            }),
            links: links.map((l) => ({
                source: l.source,
                target: l.target,
                relationDisplay: l.relationDisplayName || l.relationTypeCode,
                label: {
                    show: true,
                    formatter: l.relationDisplayName || l.relationTypeCode,
                    fontSize: 10
                },
                lineStyle: { width: 1, curveness: 0.12 }
            })),
            label: { show: true },
            lineStyle: { color: "#aaa", curveness: 0.12 },
            emphasis: { focus: "adjacency", lineStyle: { width: 2 } },
            force: {
                repulsion: 420,
                edgeLength: [72, 140],
                gravity: 0.08,
                friction: 0.62
            }
        }
    ]
});

const buildLibraryHubGraphOption = (documents) => {
    const hubCategories = [
        { name: "知识库", itemStyle: { color: "#409eff" } },
        { name: "文件", itemStyle: { color: "#67c23a" } }
    ];
    const root = {
        id: KB_ROOT_ID,
        name: "知识库",
        fullName: "知识库",
        category: 0,
        symbolSize: 54,
        itemStyle: {
            borderWidth: 2,
            borderColor: "#fff",
            shadowBlur: 10,
            shadowColor: "rgba(64,158,255,0.35)"
        },
        label: { show: true, fontSize: 14, fontWeight: "bold" }
    };
    const data = [
        root,
        ...documents.map((d) => {
            const fullName = String(d.title || d.id);
            const short = fullName.length > 18 ? `${fullName.slice(0, 16)}…` : fullName;
            return {
                id: d.id,
                name: short,
                fullName,
                category: 1,
                entityType: "文档",
                symbolSize: 22,
                label: { show: true, fontSize: 11 }
            };
        })
    ];
    const links = documents.map((d) => ({
        source: KB_ROOT_ID,
        target: d.id,
        lineStyle: { color: "#c6e2ff", width: 1.5, curveness: 0 }
    }));
    return {
        tooltip: {
            trigger: "item",
            formatter: (p) => {
                if (p.dataType === "edge") return "知识库 → 文件";
                const n = p.data || {};
                if (n.id === KB_ROOT_ID) return "知识库（中心）<br/>双击外围文件名进入该文件图谱";
                return `${n.fullName || n.name || ""}<br/>双击进入该文件交互图谱`;
            }
        },
        legend: {
            data: hubCategories.map((c) => c.name),
            bottom: 0,
            left: "center"
        },
        series: [
            {
                type: "graph",
                layout: "force",
                roam: true,
                draggable: true,
                categories: hubCategories,
                data,
                links,
                label: { show: true },
                lineStyle: { color: "#ddd" },
                emphasis: { focus: "adjacency", lineStyle: { width: 2 } },
                force: {
                    repulsion: 380,
                    edgeLength: [64, 120],
                    gravity: 0.14,
                    friction: 0.55,
                    layoutAnimation: true
                }
            }
        ]
    };
};

const attachKgHubChartEvents = () => {
    if (!kgHubChart) return;
    if (kgHubDblClickHandler) {
        try {
            kgHubChart.off("dblclick", kgHubDblClickHandler);
        } catch (_) {
            /* ignore */
        }
    }
    kgHubDblClickHandler = (p) => {
        if (p.dataType !== "node") return;
        const nid = p.data?.id;
        if (!nid || nid === KB_ROOT_ID) return;
        const full = p.data?.fullName || p.data?.name || String(nid);
        void enterKgDoc({ id: nid, title: full });
    };
    kgHubChart.on("dblclick", kgHubDblClickHandler);
};

const loadKgHubGraph = async () => {
    kgHubLoading.value = true;
    try {
        const res = await api.get("/admin/kg/library-hub-graph", { params: { limit: 450 } });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        const d = res.data?.data || {};
        const documents = Array.isArray(d.documents) ? d.documents : [];
        kgHubTruncated.value = !!d.truncated;
        kgHubLimit.value = Number(d.limit) || 400;
        kgHubDocTotal.value = Number(d.docTotal) || 0;
        kgHubDocCount.value = documents.length;
        kgHubFetched.value = true;

        await nextTick();
        disposeKgHubChart();
        if (documents.length === 0) {
            return;
        }
        if (!kgHubGraphRef.value) return;
        kgHubChart = echarts.init(kgHubGraphRef.value);
        kgHubChart.setOption(buildLibraryHubGraphOption(documents), true);
        attachKgHubChartEvents();
        kgHubChart.resize();
    } catch (e) {
        kgHubFetched.value = true;
        kgHubDocCount.value = 0;
        disposeKgHubChart();
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载知识库总览失败");
    } finally {
        kgHubLoading.value = false;
    }
};

const runLayer1EntitySearch = async () => {
    const q = layer1EntitySearchQ.value.trim();
    if (!q) {
        layer1SearchFileGroups.value = [];
        layer1SearchRan.value = false;
        return;
    }
    layer1EntitySearchLoading.value = true;
    layer1SearchRan.value = true;
    try {
        const res = await api.get("/admin/kg/entity-search-global", {
            params: { q, limit: 80 }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "搜索失败");
        const items = res.data?.data?.items || [];
        const map = new Map();
        for (const it of items) {
            const did = it.sourceDocId;
            if (!did) continue;
            if (!map.has(did)) {
                map.set(did, {
                    docId: did,
                    fileTitle: it.docTitle || did.slice(0, 8),
                    storageKey: it.storageKey,
                    matches: []
                });
            }
            map.get(did).matches.push({
                entityId: it.id,
                entityName: it.name,
                entityTypeCode: it.entityTypeCode,
                sourceChunkIndex: it.sourceChunkIndex
            });
        }
        layer1SearchFileGroups.value = [...map.values()];
    } catch (e) {
        layer1SearchFileGroups.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "搜索失败");
    } finally {
        layer1EntitySearchLoading.value = false;
    }
};

const clearLayer1EntitySearch = () => {
    layer1SearchFileGroups.value = [];
    layer1SearchRan.value = false;
};

const openFileFromLayer1Search = (g) => {
    if (!g?.docId) return;
    void enterKgDoc({
        id: g.docId,
        title: g.fileTitle,
        storageKey: g.storageKey
    });
};

const enterKgDoc = async (row) => {
    if (!row?.id) return;
    disposeKgHubChart();
    selectedKgDocId.value = row.id;
    const sk = row.storageKey != null ? String(row.storageKey) : "";
    const fromKey = sk ? sk.replace(/\\/g, "/").split("/").filter(Boolean).pop() : "";
    selectedKgDocTitle.value =
        (row.title && String(row.title).trim()) || fromKey || String(row.id).slice(0, 8);
    entitySearchResults.value = [];
    entitySearchQ.value = "";
    entitySearchRan.value = false;
    kgLastGraphNodes.value = [];
    await nextTick();
    void loadKgDocGraph();
};

const backToKgDocList = () => {
    selectedKgDocId.value = null;
    selectedKgDocTitle.value = "";
    entitySearchResults.value = [];
    entitySearchQ.value = "";
    entitySearchRan.value = false;
    kgLastGraphNodes.value = [];
    kgGraphFetched.value = false;
    kgGraphNodeCount.value = 0;
    disposeKgDocChart();
    void loadKgHubGraph();
};

const runKgEntitySearch = async () => {
    const docId = selectedKgDocId.value;
    if (!docId) return;
    const q = entitySearchQ.value.trim();
    if (!q) {
        entitySearchResults.value = [];
        entitySearchRan.value = false;
        return;
    }
    entitySearchLoading.value = true;
    entitySearchRan.value = true;
    try {
        const res = await api.get("/admin/kg/entity-search", {
            params: { docId, q, limit: 40 }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "搜索失败");
        entitySearchResults.value = res.data?.data?.items || [];
    } catch (e) {
        entitySearchResults.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "搜索失败");
    } finally {
        entitySearchLoading.value = false;
    }
};

const onEntitySearchClear = () => {
    entitySearchResults.value = [];
    entitySearchRan.value = false;
};

const focusKgEntityOnGraph = (entityId) => {
    const id = String(entityId || "").trim().toLowerCase();
    if (!id || !kgDocChart) return;
    const nodes = kgLastGraphNodes.value || [];
    const idx = nodes.findIndex((n) => String(n.id || "").trim().toLowerCase() === id);
    if (idx < 0) {
        ElMessage.warning("该实体不在当前展示的子图中（可能超出边数上限，可尝试调大 limit 或缩小文档图谱）");
        return;
    }
    try {
        kgDocChart.dispatchAction({ type: "focusNodeAdjacency", seriesIndex: 0, dataIndex: idx });
    } catch (_) {
        /* ignore */
    }
    try {
        kgDocChart.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: idx });
    } catch (_) {
        /* ignore */
    }
};

const loadKgDocGraph = async () => {
    if (!selectedKgDocId.value) {
        kgGraphFetched.value = false;
        kgGraphNodeCount.value = 0;
        return;
    }
    kgGraphLoading.value = true;
    try {
        const res = await api.get("/admin/kg/graph", {
            params: { limit: 500, docId: selectedKgDocId.value }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        const d = res.data?.data || {};
        const nodes = Array.isArray(d.nodes) ? d.nodes : [];
        const links = Array.isArray(d.links) ? d.links : [];
        kgLastGraphNodes.value = nodes;
        kgGraphTruncated.value = !!d.truncated;
        kgGraphLimit.value = Number(d.limit) || 500;
        kgGraphEdgeTotal.value = Number(d.edgeTotal) || 0;
        kgGraphNodeCount.value = nodes.length;
        kgGraphFetched.value = true;

        await nextTick();
        if (nodes.length === 0) {
            disposeKgDocChart();
            return;
        }
        if (!kgDocGraphRef.value) return;
        if (!kgDocChart) kgDocChart = echarts.init(kgDocGraphRef.value);
        kgDocChart.setOption(buildKgForceGraphOption(nodes, links), true);
        resizeKgGraph();
    } catch (e) {
        kgGraphFetched.value = true;
        kgGraphNodeCount.value = 0;
        disposeKgDocChart();
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载图谱失败");
    } finally {
        kgGraphLoading.value = false;
    }
};

/** 全库子图（第二栏「交互图谱」） */
const loadKgGlobalGraph = async () => {
    kgGlobalGraphLoading.value = true;
    try {
        const res = await api.get("/admin/kg/graph", { params: { limit: 500 } });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        const d = res.data?.data || {};
        const nodes = Array.isArray(d.nodes) ? d.nodes : [];
        const links = Array.isArray(d.links) ? d.links : [];
        kgGlobalGraphTruncated.value = !!d.truncated;
        kgGlobalGraphLimit.value = Number(d.limit) || 500;
        kgGlobalGraphEdgeTotal.value = Number(d.edgeTotal) || 0;
        kgGlobalGraphNodeCount.value = nodes.length;
        kgGlobalGraphFetched.value = true;

        await nextTick();
        if (nodes.length === 0) {
            disposeKgGlobalChart();
            return;
        }
        if (!kgGlobalGraphRef.value) return;
        if (!kgGlobalChart) kgGlobalChart = echarts.init(kgGlobalGraphRef.value);
        kgGlobalChart.setOption(buildKgForceGraphOption(nodes, links), true);
        resizeKgGraph();
    } catch (e) {
        kgGlobalGraphFetched.value = true;
        kgGlobalGraphNodeCount.value = 0;
        disposeKgGlobalChart();
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载图谱失败");
    } finally {
        kgGlobalGraphLoading.value = false;
    }
};

const activeTab = ref("double-layer-kg");

const summary = ref({
    entityCount: 0,
    edgeCount: 0,
    entityTypeCount: 0,
    relationTypeCount: 0,
    relationTypesKept: ["references", "belongs_to", "applies_to", "supersedes"]
});

const entityInstRows = ref([]);
const entityInstLoading = ref(false);
const entityInstPage = ref(1);
const entityInstPageSize = ref(20);
const entityInstTotal = ref(0);

const edgeInstRows = ref([]);
const edgeInstLoading = ref(false);
const edgeInstPage = ref(1);
const edgeInstPageSize = ref(20);
const edgeInstTotal = ref(0);

const entityInstDlg = ref(false);
const entityInstSaving = ref(false);
const entityInstForm = ref({
    entityTypeCode: "",
    name: "",
    propertiesJson: "",
    sourceDocId: "",
    sourceChunkIndex: undefined
});

const edgeDlg = ref(false);
const edgeSaving = ref(false);
const edgeForm = ref({
    relationTypeCode: "",
    fromEntityId: "",
    toEntityId: "",
    sourceDocId: "",
    confidence: undefined,
    propertiesJson: ""
});

const entityRows = ref([]);
const entityLoading = ref(false);
const relationRows = ref([]);
const relationLoading = ref(false);

const entityPickerList = ref([]);

const activeEntityTypes = computed(() =>
    (entityRows.value || []).filter((x) => x.isActive !== false)
);

const entityDlg = ref(false);
const entitySaving = ref(false);
const entityForm = ref({
    code: "",
    displayName: "",
    description: "",
    sortOrder: 100
});

const relationDlg = ref(false);
const relationSaving = ref(false);
const relationForm = ref({
    code: "",
    displayName: "",
    description: "",
    domainTypeCode: "",
    rangeTypeCode: "",
    sortOrder: 100
});

const loadEntityTypes = async () => {
    entityLoading.value = true;
    try {
        const res = await api.get("/admin/kg/entity-types");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        entityRows.value = res.data?.data?.items || [];
    } catch (e) {
        entityRows.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载实体类型失败");
    } finally {
        entityLoading.value = false;
    }
};

const loadRelationTypes = async () => {
    relationLoading.value = true;
    try {
        const res = await api.get("/admin/kg/relation-types");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        relationRows.value = res.data?.data?.items || [];
    } catch (e) {
        relationRows.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载关系类型失败");
    } finally {
        relationLoading.value = false;
    }
};

const openEntityDialog = () => {
    entityDlg.value = true;
};

const openRelationDialog = () => {
    relationDlg.value = true;
};

const resetEntityForm = () => {
    entityForm.value = { code: "", displayName: "", description: "", sortOrder: 100 };
};

const resetRelationForm = () => {
    relationForm.value = {
        code: "",
        displayName: "",
        description: "",
        domainTypeCode: "",
        rangeTypeCode: "",
        sortOrder: 100
    };
};

const submitEntity = async () => {
    const { code, displayName, description, sortOrder } = entityForm.value;
    if (!code.trim() || !displayName.trim()) {
        ElMessage.warning("请填写 code 与显示名称");
        return;
    }
    entitySaving.value = true;
    try {
        const res = await api.post("/admin/kg/entity-types", {
            code: code.trim(),
            displayName: displayName.trim(),
            description: description.trim(),
            sortOrder
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        ElMessage.success("已新增实体类型");
        entityDlg.value = false;
        await loadEntityTypes();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
    } finally {
        entitySaving.value = false;
    }
};

const submitRelation = async () => {
    const f = relationForm.value;
    if (!f.code.trim() || !f.displayName.trim()) {
        ElMessage.warning("请填写 code 与显示名称");
        return;
    }
    relationSaving.value = true;
    try {
        const res = await api.post("/admin/kg/relation-types", {
            code: f.code.trim(),
            displayName: f.displayName.trim(),
            description: f.description.trim(),
            domainTypeCode: f.domainTypeCode.trim() || undefined,
            rangeTypeCode: f.rangeTypeCode.trim() || undefined,
            sortOrder: f.sortOrder
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        ElMessage.success("已新增关系类型");
        relationDlg.value = false;
        await loadRelationTypes();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
    } finally {
        relationSaving.value = false;
    }
};

const loadSummary = async () => {
    try {
        const res = await api.get("/admin/kg/summary");
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        const d = res.data?.data || {};
        summary.value = {
            entityCount: d.entityCount ?? 0,
            edgeCount: d.edgeCount ?? 0,
            entityTypeCount: d.entityTypeCount ?? 0,
            relationTypeCount: d.relationTypeCount ?? 0,
            relationTypesKept: d.relationTypesKept || summary.value.relationTypesKept
        };
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载统计失败");
    }
};

const loadEntityInstances = async () => {
    entityInstLoading.value = true;
    try {
        const res = await api.get("/admin/kg/entities", {
            params: { page: entityInstPage.value, pageSize: entityInstPageSize.value }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        entityInstRows.value = res.data?.data?.items || [];
        entityInstTotal.value = Number(res.data?.data?.total) || 0;
    } catch (e) {
        entityInstRows.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载实体实例失败");
    } finally {
        entityInstLoading.value = false;
    }
};

const onEntityInstSizeChange = () => {
    entityInstPage.value = 1;
    void loadEntityInstances();
};

const loadEdgeInstances = async () => {
    edgeInstLoading.value = true;
    try {
        const res = await api.get("/admin/kg/edges", {
            params: { page: edgeInstPage.value, pageSize: edgeInstPageSize.value }
        });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        edgeInstRows.value = res.data?.data?.items || [];
        edgeInstTotal.value = Number(res.data?.data?.total) || 0;
    } catch (e) {
        edgeInstRows.value = [];
        ElMessage.error(e?.response?.data?.msg || e?.message || "加载关系实例失败");
    } finally {
        edgeInstLoading.value = false;
    }
};

const onEdgeInstSizeChange = () => {
    edgeInstPage.value = 1;
    void loadEdgeInstances();
};

const loadEntityPickerList = async () => {
    try {
        const res = await api.get("/admin/kg/entities", { params: { page: 1, pageSize: 500 } });
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "加载失败");
        entityPickerList.value = res.data?.data?.items || [];
    } catch {
        entityPickerList.value = [];
    }
};

const openEntityInstDialog = async () => {
    if (!entityRows.value.length) await loadEntityTypes();
    entityInstDlg.value = true;
};

const resetEntityInstForm = () => {
    entityInstForm.value = {
        entityTypeCode: "",
        name: "",
        propertiesJson: "",
        sourceDocId: "",
        sourceChunkIndex: undefined
    };
};

const submitEntityInst = async () => {
    const f = entityInstForm.value;
    if (!f.entityTypeCode || !f.name.trim()) {
        ElMessage.warning("请选择实体类型并填写名称");
        return;
    }
    const body = {
        entityTypeCode: f.entityTypeCode,
        name: f.name.trim(),
        properties: f.propertiesJson.trim() || undefined,
        sourceDocId: f.sourceDocId.trim() || undefined,
        sourceChunkIndex:
            f.sourceChunkIndex != null && f.sourceChunkIndex !== "" ? f.sourceChunkIndex : undefined
    };
    entityInstSaving.value = true;
    try {
        const res = await api.post("/admin/kg/entities", body);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        ElMessage.success("已创建实体");
        entityInstDlg.value = false;
        await loadEntityInstances();
        await loadSummary();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
    } finally {
        entityInstSaving.value = false;
    }
};

const deleteEntityInst = async (row) => {
    try {
        await ElMessageBox.confirm(`确定删除实体「${row.name}」？其关联边将一并删除。`, "确认", {
            type: "warning"
        });
    } catch {
        return;
    }
    try {
        const res = await api.delete(`/admin/kg/entities/${row.id}`);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "删除失败");
        ElMessage.success("已删除");
        await loadEntityInstances();
        await loadEdgeInstances();
        await loadSummary();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "删除失败");
    }
};

const openEdgeDlg = () => {
    edgeDlg.value = true;
};

const resetEdgeForm = () => {
    edgeForm.value = {
        relationTypeCode: "",
        fromEntityId: "",
        toEntityId: "",
        sourceDocId: "",
        confidence: undefined,
        propertiesJson: ""
    };
};

const submitEdge = async () => {
    const f = edgeForm.value;
    if (!f.relationTypeCode || !f.fromEntityId || !f.toEntityId) {
        ElMessage.warning("请完整选择关系与头尾实体");
        return;
    }
    const body = {
        relationTypeCode: f.relationTypeCode,
        fromEntityId: f.fromEntityId,
        toEntityId: f.toEntityId,
        sourceDocId: f.sourceDocId.trim() || undefined,
        properties: f.propertiesJson.trim() || undefined
    };
    if (f.confidence != null && f.confidence !== "") {
        body.confidence = f.confidence;
    }
    edgeSaving.value = true;
    try {
        const res = await api.post("/admin/kg/edges", body);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "保存失败");
        ElMessage.success("已创建关系边");
        edgeDlg.value = false;
        await loadEdgeInstances();
        await loadSummary();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "保存失败");
    } finally {
        edgeSaving.value = false;
    }
};

const deleteEdgeInst = async (row) => {
    try {
        await ElMessageBox.confirm(`确定删除关系「${row.relationTypeCode}」这条边？`, "确认", {
            type: "warning"
        });
    } catch {
        return;
    }
    try {
        const res = await api.delete(`/admin/kg/edges/${row.id}`);
        if (res.data?.code !== 200) throw new Error(res.data?.msg || "删除失败");
        ElMessage.success("已删除");
        await loadEdgeInstances();
        await loadSummary();
    } catch (e) {
        ElMessage.error(e?.response?.data?.msg || e?.message || "删除失败");
    }
};

const onKgTabChange = (name) => {
    if (name !== "interactive-graph") disposeKgGlobalChart();
    if (name !== "double-layer-kg") disposeKgHubChart();
    if (name === "overview") void loadSummary();
    if (name === "entity-instances") void loadEntityInstances();
    if (name === "edge-instances") void loadEdgeInstances();
    if (name === "double-layer-kg") {
        if (selectedKgDocId.value) void loadKgDocGraph();
        else void loadKgHubGraph();
    }
    if (name === "interactive-graph") void loadKgGlobalGraph();
};

onMounted(async () => {
    void loadSummary();
    void loadEntityTypes();
    void loadRelationTypes();
    await nextTick();
    void loadKgHubGraph();
    window.addEventListener("resize", resizeKgGraph);
});

onUnmounted(() => {
    window.removeEventListener("resize", resizeKgGraph);
    disposeAllKgCharts();
});
</script>

<style scoped>
.kg-page {
    width: 100%;
    max-width: none;
    box-sizing: border-box;
    margin: 0;
    padding: 0 16px 24px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
}
.kg-merged-panel {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    overflow: hidden;
    background: var(--el-bg-color);
}
.kg-readme-wrap {
    max-width: 900px;
    padding: 16px 20px 24px;
    background: linear-gradient(135deg, #f5f9ff 0%, #ffffff 55%);
    border-radius: 10px;
    border: 1px solid #d9ecff;
}
.kg-readme-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
}
.kg-readme-version-badge {
    display: inline-block;
    padding: 10px 16px;
    background: #409eff;
    color: #fff;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
}
.kg-title {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
    color: #303133;
}
.kg-sub {
    margin: 0 0 12px;
    font-size: 14px;
    line-height: 1.6;
    color: #606266;
    max-width: min(720px, 100%);
}
.kg-sub code {
    font-size: 12px;
    padding: 1px 6px;
    background: #f4f4f5;
    border-radius: 4px;
}
.kg-tabs {
    border-radius: 8px;
    overflow: hidden;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.kg-tabs--in-panel {
    border-radius: 0;
    border: none;
    box-shadow: none;
}
.kg-tabs--in-panel :deep(.el-tabs--border-card) {
    border: none;
    box-shadow: none;
}
.kg-tabs--in-panel :deep(.el-tabs__header) {
    margin: 0;
}
.kg-tabs :deep(.el-tabs__header) {
    flex-shrink: 0;
}
.kg-tabs :deep(.el-tabs__content) {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}
.kg-tabs :deep(.el-tab-pane) {
    min-height: 0;
}
.kg-stat-row {
    margin-bottom: 16px;
}
.kg-stat-card {
    text-align: center;
    border-radius: 10px;
}
.kg-stat-num {
    font-size: 26px;
    font-weight: 700;
    color: #409eff;
    line-height: 1.2;
}
.kg-stat-label {
    margin-top: 6px;
    font-size: 13px;
    color: #606266;
}
.kg-overview-line {
    margin: 0 0 12px;
    font-size: 14px;
    color: #303133;
    line-height: 1.6;
}
.kg-tag-gap {
    margin-right: 6px;
    margin-bottom: 4px;
}
.kg-pager {
    margin-top: 12px;
    display: flex;
    justify-content: flex-end;
}
.kg-cell-strong {
    font-weight: 600;
    color: #303133;
}
.kg-cell-sub {
    margin-left: 4px;
    font-size: 12px;
    color: #909399;
}
.kg-toolbar {
    margin-bottom: 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}
.kg-toolbar--hub {
    margin-bottom: 8px;
    align-items: center;
    gap: 10px;
}
.kg-toolbar-hint {
    flex: 1 1 auto;
    min-width: 120px;
    font-size: 12px;
    color: #606266;
    line-height: 1.45;
}
.kg-toolbar-hint strong {
    color: #303133;
}
.kg-table {
    width: 100%;
}
.kg-hint {
    font-size: 13px;
    color: #606266;
    line-height: 1.55;
    margin: 0 0 12px;
    padding: 10px 12px;
    background: #fdf6ec;
    border-radius: 8px;
    border-left: 4px solid #e6a23c;
}
.kg-footnote {
    margin: 12px 0 0;
    font-size: 12px;
    color: #909399;
}
.kg-layer-hub-row {
    min-height: 0;
}
.kg-graph-intro {
    margin: 0 0 12px;
    font-size: 13px;
    color: #606266;
    line-height: 1.55;
}
.kg-graph-alert {
    margin-bottom: 12px;
}
.kg-graph-wrap {
    min-height: clamp(280px, calc(100vh - 360px), 1200px);
    height: clamp(320px, calc(100vh - 340px), 1200px);
    border-radius: 8px;
    border: 1px solid #ebeef5;
    background: #fafafa;
}
.kg-layer-hub,
.kg-layer-graph {
    min-height: 0;
}
.kg-doc-nav {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;
}
.kg-doc-nav-title {
    font-size: 15px;
    font-weight: 600;
    color: #303133;
}
.kg-split-row {
    margin-top: 4px;
    align-items: stretch;
}
.kg-search-panel-inner {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #ebeef5;
    background: #fafafa;
    min-height: clamp(280px, calc(100vh - 380px), 1100px);
    max-height: clamp(300px, calc(100vh - 320px), 1200px);
}
.kg-search-title {
    font-size: 13px;
    font-weight: 600;
    color: #606266;
}
.kg-search-scroll {
    flex: 1 1 auto;
    min-height: 160px;
}
.kg-search-hit {
    padding: 8px 10px;
    margin-bottom: 6px;
    border-radius: 6px;
    background: #fff;
    border: 1px solid #e4e7ed;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
}
.kg-search-hit:hover {
    border-color: #c6e2ff;
    box-shadow: 0 1px 4px rgba(64, 158, 255, 0.15);
}
.kg-search-hit-name {
    font-size: 13px;
    font-weight: 500;
    color: #303133;
    word-break: break-word;
}
.kg-search-hit-meta {
    margin-top: 4px;
    font-size: 12px;
    color: #909399;
}
.kg-graph-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.kg-graph-wrap-split {
    flex: 1 1 auto;
    min-height: clamp(280px, calc(100vh - 400px), 1100px);
}
/* 第一层：提示并入工具栏后，原图下方脚注去掉，略增大图谱可视高度 */
.kg-graph-wrap--hub {
    min-height: clamp(300px, calc(100vh - 268px), 1200px);
    height: clamp(320px, calc(100vh - 248px), 1200px);
}
.kg-echarts-graph {
    width: 100%;
    height: 100%;
    min-height: 280px;
}
</style>
